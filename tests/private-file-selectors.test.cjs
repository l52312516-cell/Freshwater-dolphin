'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const native = require('../src/qq/msf-native.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const { TransportHub } = require('../src/onebot/transports.cjs');
const { nodeConfig } = require('../src/config.cjs');

const SELF = '12345', PEER = '22222', HASH = 'Observed-雪+/=AbC';
function message(index = 1, patch = {}) {
    return { chatType: 1, peerUid: 'u_peer', peerUin: PEER,
        msgId: String(18446744073709551000n + BigInt(index)), msgSeq: String(index), clientSeq: String(index + 100),
        senderUid: 'u_peer', senderUin: PEER, msgTime: '1800000000', sendNickName: 'Synthetic',
        elements: [{ elementType: 3, elementId: String(18446744073709550000n + BigInt(index)), fileElement: {
            fileUuid: 'file-1', file10MMd5: HASH, fileName: 'synthetic.txt', fileSize: '42' } }], ...patch };
}
function fixture(t, { maxMessages = 100, initial = message() } = {}) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'private-file-selectors-'));
    const capture = new Capture({ install: false, processObject: { env: {} } });
    Object.assign(capture, { ready: true, online: true, qqVersion: TARGET_VERSION, epoch: 'selector-epoch', self: { uin: SELF, uid: 'u_self' } });
    capture.remember(SELF, 'u_self'); capture.remember(PEER, 'u_peer'); capture.remember('33333', 'u_other');
    const records = new Map(), rpc = [], sent = [];
    let reads = 0, onRead;
    capture.session = { getMsgService: () => ({ getMsgsByMsgId(peer, ids) {
        reads++;
        const record = records.get(ids[0]);
        const copy = record && structuredClone(record);
        const actual = onRead ? onRead(reads, copy) : copy;
        return { result: 0, msgList: actual ? [actual] : [] };
    } }) };
    t.mock.method(native, 'run', async (_capture, params) => {
        sent.push(params); return { fileId: params.fileId, url: 'https://download.qq.com/synthetic?token=synthetic' };
    });
    const state = () => ({ epoch: capture.epoch, ready: capture.ready, online: true, self: capture.self,
        qqVersion: TARGET_VERSION, capabilities: { privateFileUrl: true, messages: true } });
    const backend = { async call(method, params = {}, options = {}) {
        if (method === 'status') return state();
        rpc.push({ method, params });
        return capture.call(method, params, { expiresAt: Date.now() + (options.timeoutMs ?? 10000), signal: options.signal });
    } };
    const store = new MessageStore({ directory: path.join(directory, 'messages'), maxMessages });
    const service = new OneBotService({ backend, store, actionTimeoutMs: 1000 });
    const add = (record, account = SELF) => { records.set(record.msgId, structuredClone(record)); return store.remember(account, record).id; };
    const id = initial && add(initial);
    t.after(() => { capture.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return { directory, capture, service, store, rpc, sent, records, add, id,
        get reads() { return reads; }, set onRead(value) { onRead = value; },
        action(params, echo = null) { return service.action({ action: 'get_private_file_url', params, echo }); } };
}
function failedWithoutSend(f, result, code) {
    assert.equal(result.status, 'failed'); assert.equal(result.data, null);
    if (code !== undefined) assert.equal(result.retcode, code, result.message);
    assert.equal(f.sent.length, 0);
}

test('file_id alone resolves a retained account file, refreshes it and binds both observed resource fields', async t => {
    const f = fixture(t), echo = { selector: [false, null] };
    const result = await f.action({ file_id: 'file-1' }, echo);
    assert.equal(result.retcode, 0, result.message); assert.deepEqual(result.echo, echo);
    assert.deepEqual(result.data, { url: 'https://download.qq.com/synthetic?token=synthetic' });
    assert.equal(f.reads, 2); assert.equal(f.sent.length, 1);
    const call = f.rpc.find(item => item.method === 'nativePrivateFileUrl');
    assert.equal(call.params.expectedFileId, 'file-1'); assert.equal(call.params.expectedFileHash, HASH);
    assert.equal(call.params.elementId, message().elements[0].elementId);
    assert.equal(f.sent[0].fileHash, HASH); assert.equal(f.sent[0].expectedEpoch, 'selector-epoch');
});

test('optional user_id selects the private peer for inbound and outbound files', async t => {
    for (const outbound of [false, true]) await t.test(outbound ? 'outbound' : 'inbound', async t => {
        const initial = message(1, outbound ? { senderUin: SELF, senderUid: 'u_self' } : {});
        const f = fixture(t, { initial });
        const result = await f.action({ file_id: 'file-1', user_id: Number(PEER), file_hash: HASH });
        assert.equal(result.retcode, 0, result.message); assert.equal(f.sent.length, 1);
        assert.equal(f.rpc.find(item => item.method === 'resolve').params.uin, PEER);
        assert.equal(f.rpc.find(item => item.method === 'nativePrivateFileUrl').params.peer.peerUid, 'u_peer');
    });
});

test('received private file conversion supplies the same complete resource binding', async t => {
    const f = fixture(t);
    const result = await f.service.action({ action: 'get_msg', params: { message_id: f.id } });
    assert.equal(result.retcode, 0, result.message);
    assert.equal(result.data.message[0].type, 'file'); assert.match(result.data.message[0].data.url, /^https:\/\/download\.qq\.com\//);
    const call = f.rpc.find(item => item.method === 'nativePrivateFileUrl');
    assert.equal(call.params.expectedFileId, 'file-1'); assert.equal(call.params.expectedFileHash, HASH);
    assert.equal(f.sent.length, 1);
});

test('HTTP GET, form and JSON preserve opaque file selectors and reach the real private lookup', async t => {
    const f = fixture(t), config = { profileId: 'selector', gatewayPort: 0,
        nodes: [nodeConfig({ id: 'api', type: 'httpApi', token: 'synthetic-token' }, 0)] };
    const hub = new TransportHub({ config, action: (request, session) => f.service.action(request, session),
        status: () => f.service.status() });
    await hub.open(); hub.start(SELF, 'selector-epoch'); t.after(() => hub.close());
    const url = 'http://127.0.0.1:' + hub.port + '/onebot/selector/api/get_private_file_url';
    const params = { file_id: 'file-1', user_id: PEER, file_hash: HASH };
    const query = new URLSearchParams({ ...params, access_token: 'synthetic-token' });
    const get = await fetch(url + '?' + query).then(value => value.json());
    const form = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer synthetic-token',
        'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) }).then(value => value.json());
    const json = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer synthetic-token',
        'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, user_id: Number(PEER) }) }).then(value => value.json());
    assert.equal(get.retcode, 0, get.message); assert.deepEqual(form, get); assert.deepEqual(json, get);
    assert.equal(f.sent.length, 3); assert(f.sent.every(item => item.fileHash === HASH));
});

test('message_id remains supported and peer/hash selectors constrain both public lookup modes', async t => {
    const f = fixture(t);
    for (const selectors of [{ file_id: 'file-1' }, { message_id: f.id }]) {
        failedWithoutSend(f, await f.action({ ...selectors, user_id: '33333' }));
        failedWithoutSend(f, await f.action({ ...selectors, file_hash: 'foreign-hash' }), 1404);
    }
    assert.equal(f.reads, 0);
    for (const file_hash of ['', HASH]) {
        const result = await f.action({ message_id: f.id, file_id: 'file-1', user_id: PEER, file_hash });
        assert.equal(result.retcode, 0, result.message);
    }
    assert.equal(f.sent.length, 2); assert(f.sent.every(item => item.fileHash === HASH));
});

test('all selector syntax is checked before any resolve or message lookup', async t => {
    const f = fixture(t);
    const patches = [
        { file_id: '' }, { file_id: null }, { file_id: undefined }, { file_id: 1 }, { file_id: 'x\0y' },
        { file_id: '\ud800' }, { file_id: '雪'.repeat(342) },
        { file_hash: null }, { file_hash: undefined }, { file_hash: 1 }, { file_hash: 'x\ny' },
        { file_hash: '\ud800' }, { file_hash: '雪'.repeat(1366) },
        { user_id: null }, { user_id: undefined }, { user_id: 0 }, { user_id: '1e3' }, { user_id: false },
        { message_id: null }, { message_id: undefined }, { message_id: 0 }, { message_id: '1e3' },
        { diagnostic: 'resource-metadata' }
    ];
    for (const patch of patches) failedWithoutSend(f, await f.action({ file_id: 'file-1', user_id: PEER, ...patch }), 1400);
    failedWithoutSend(f, await f.action({}), 1400);
    assert.equal(f.rpc.length, 0); assert.equal(f.reads, 0);
});

test('duplicate resource locators are ambiguous while peer or exact hash can narrow distinct candidates', async t => {
    await t.test('same UUID/hash and same peer requires message_id', async t => {
        const f = fixture(t); f.add(message(2));
        failedWithoutSend(f, await f.action({ file_id: 'file-1', user_id: PEER, file_hash: HASH }), 1400);
        assert.equal(f.reads, 0);
        assert.equal((await f.action({ message_id: f.id, file_id: 'file-1' })).retcode, 0);
    });
    await t.test('different peers require a peer selector', async t => {
        const f = fixture(t); f.add(message(2, { peerUid: 'u_other', peerUin: '33333', senderUid: 'u_other', senderUin: '33333' }));
        failedWithoutSend(f, await f.action({ file_id: 'file-1' }), 1400);
        assert.equal((await f.action({ file_id: 'file-1', user_id: PEER })).retcode, 0);
    });
    await t.test('exact opaque hash can narrow two versions', async t => {
        const f = fixture(t), second = message(2); second.elements[0].fileElement.file10MMd5 = 'Another+/=Hash'; f.add(second);
        failedWithoutSend(f, await f.action({ file_id: 'file-1' }), 1400);
        failedWithoutSend(f, await f.action({ file_id: 'file-1', file_hash: HASH.toLowerCase() }), 1404);
        assert.equal((await f.action({ file_id: 'file-1', file_hash: HASH })).retcode, 0);
    });
    await t.test('duplicate elements remain ambiguous even in a known message', async t => {
        const initial = message(); initial.elements.push(structuredClone(initial.elements[0])); const f = fixture(t, { initial });
        for (const selectors of [{ file_id: 'file-1' }, { message_id: f.id }]) failedWithoutSend(f, await f.action(selectors), 1400);
        assert.equal(f.reads, 0);
    });
});

test('incomplete candidates cannot disappear behind a valid UUID/hash candidate', async t => {
    for (const missing of ['hash', 'element']) await t.test(missing, async t => {
        const f = fixture(t), other = message(2);
        if (missing === 'hash') delete other.elements[0].fileElement.file10MMd5;
        else delete other.elements[0].elementId;
        f.add(other);
        failedWithoutSend(f, await f.action({ file_id: 'file-1', file_hash: HASH }));
        assert.equal(f.reads, 0);
    });
    await t.test('message_id alone cannot hide a file with missing payload', async t => {
        const initial = message(); initial.elements.push({ elementType: 3, elementId: 'incomplete-file' });
        const f = fixture(t, { initial });
        failedWithoutSend(f, await f.action({ message_id: f.id })); assert.equal(f.reads, 0);
    });
});

test('file_id lookup is account isolated and excludes recalled records', async t => {
    await t.test('another account cannot supply its record', async t => {
        const f = fixture(t, { initial: null }); f.add(message(), '54321');
        failedWithoutSend(f, await f.action({ file_id: 'file-1' }), 1404); assert.equal(f.reads, 0);
    });
    await t.test('known recall excludes both lookup modes', async t => {
        const f = fixture(t); f.store.setRecalled(SELF, f.id);
        for (const selectors of [{ file_id: 'file-1' }, { message_id: f.id }]) failedWithoutSend(f, await f.action(selectors), 1404);
        assert.equal(f.reads, 0);
    });
});

test('pruned records require their existing message_id while retained file selectors survive restart', async t => {
    await t.test('pruned locator is not a file_id index', async t => {
        const f = fixture(t, { maxMessages: 1 }), other = message(2); other.elements[0].fileElement.fileUuid = 'file-2'; f.add(other);
        assert.equal(f.store.get(SELF, f.id).record, undefined);
        failedWithoutSend(f, await f.action({ file_id: 'file-1' }), 1404); assert.equal(f.reads, 0);
        const result = await f.action({ message_id: f.id, file_id: 'file-1', user_id: PEER, file_hash: HASH });
        assert.equal(result.retcode, 0, result.message); assert.equal(f.store.get(SELF, f.id).id, f.id);
    });
    await t.test('retained record reloads with its original ID', async t => {
        const f = fixture(t); f.store.close();
        f.service.store = new MessageStore({ directory: path.join(f.directory, 'messages') });
        const result = await f.action({ file_id: 'file-1', file_hash: HASH });
        assert.equal(result.retcode, 0, result.message); assert.equal(f.service.store.get(SELF, f.id).id, f.id);
    });
});

test('resource changes during refresh or the native second read never submit SSO', async t => {
    for (const read of [1, 2]) for (const change of ['uuid', 'hash', 'hash-case', 'element']) await t.test(`read ${read}: ${change}`, async t => {
        const f = fixture(t);
        f.onRead = (count, record) => {
            if (count === read) {
                if (change === 'uuid') record.elements[0].fileElement.fileUuid = 'foreign-file';
                else if (change === 'hash') record.elements[0].fileElement.file10MMd5 = 'foreign-hash';
                else if (change === 'hash-case') record.elements[0].fileElement.file10MMd5 = HASH.toLowerCase();
                else record.elements[0].elementId = 'foreign-element';
            }
            return record;
        };
        failedWithoutSend(f, await f.action({ file_id: 'file-1' })); assert.equal(f.reads, read);
    });
});

test('a concurrently replaced locator or recall cannot authorize the selected file after refresh', async t => {
    await t.test('the original locator is frozen before the refresh', async t => {
        const f = fixture(t), original = f.store.findPrivateFile.bind(f.store);
        t.mock.method(f.store, 'findPrivateFile', (...args) => {
            const selected = original(...args), replacement = message(1, { msgSeq: '999' });
            f.add(replacement); return selected;
        });
        failedWithoutSend(f, await f.action({ file_id: 'file-1' })); assert.equal(f.reads, 1);
    });
    await t.test('recall observed while refreshing rejects before the native query', async t => {
        const f = fixture(t);
        f.onRead = (_count, record) => { f.store.setRecalled(SELF, f.id); return record; };
        failedWithoutSend(f, await f.action({ file_id: 'file-1' }), 1404); assert.equal(f.reads, 1);
    });
});
