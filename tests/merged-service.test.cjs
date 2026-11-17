'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');

const SELF = '1000000001', GROUP = '2000000001', USER = '1000000003';
const NATIVE_ID = '18446744073709551001';
const PNG = 'base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const text = value => ({ type: 'text', data: { text: value } });
const image = () => ({ type: 'image', data: { file: PNG } });
const node = (content = [text('  report\n ')], selfId = SELF, name = '延迟检测报告') => ({
    type: 'node', data: { user_id: selfId, nickname: name, content }
});
const mixed = (selfId = SELF) => Array.from({ length: 15 }, (_, index) => [
    node([text('  文本 ' + index + '\n ')], selfId, '📤 文本测试'),
    node([image(), text('图片 ' + index)], selfId, '🖼 图片测试')
]).flat();
const request = (messages = [node()], privateTarget = false, echo = { sequence: 7 }) => ({
    action: privateTarget ? 'send_private_forward_msg' : 'send_group_forward_msg', echo,
    params: { [privateTarget ? 'user_id' : 'group_id']: privateTarget ? USER : GROUP, messages }
});

function fixture(t, { selfId = SELF, actionTimeoutMs = 10000, mediaActionTimeoutMs = 60000 } = {}) {
    const parent = path.resolve(__dirname, '../work/temp');
    fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'merged-service-'));
    t.after(() => {
        // This fixture owns exactly this verified workspace-local directory.
        assert.equal(path.dirname(directory), parent);
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const mediaDirectory = path.join(directory, 'media'), storeDirectory = path.join(directory, 'store');
    fs.mkdirSync(mediaDirectory, { mode: 0o700 });
    const state = { ready: true, online: true, epoch: 'merge-epoch-' + selfId,
        self: { uin: selfId, uid: 'u_' + selfId, nickname: 'Real self' },
        capabilities: { mergeCustom: true, forwardRead: true, text: true, image: true, messages: true } };
    const calls = [], logs = [], handlers = {};
    function receipt(params) {
        const record = { ...params.destination, msgId: NATIVE_ID, msgSeq: '100', clientSeq: '200', msgTime: '1794710400',
            senderUin: selfId, senderUid: state.self.uid, sendStatus: 2, sendNickName: 'Real self',
            elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'complete-test-resource' } }] };
        return { confirmed: true, confirmation: params.kind === 'customResourceMerge' ?
            'custom-resource-metadata-and-delivery-readback' : 'fresh-source-tuple-and-resource-readback',
            destination: { ...params.destination }, nodeCount: params.nodes.length,
            resId: 'complete-test-resource', messageId: NATIVE_ID, record,
            debugPath: '/private/QQ/native-cache', token: 'private-token-must-not-return' };
    }
    const backend = { async call(method, params, context) {
        if (method === 'status') return structuredClone(state);
        calls.push({ method, params, context });
        if (handlers[method]) return handlers[method](params, context);
        if (method === 'resolve') return { uin: params.uin, uid: 'u_destination' };
        if (method === 'prepareMedia') {
            assert.equal(params.type, 'image');
            assert.equal(params.expectedEpoch, state.epoch);
            assert.equal(path.dirname(params.file), mediaDirectory);
            assert.deepEqual(fs.readFileSync(params.file), Buffer.from(PNG.slice(9), 'base64'));
            return { elementType: 2, elementId: '', picElement: {
                sourcePath: '/private/QQ/native-cache/' + selfId, md5HexStr: 'verified-fixture-image'
            } };
        }
        if (method === 'forwardOperation') return receipt(params);
        throw new Error('Unexpected fixture backend method');
    } };
    const store = new MessageStore({ directory: storeDirectory });
    const service = new OneBotService({ backend, store, mediaDirectory, actionTimeoutMs, mediaActionTimeoutMs,
        profileId: 'profile-' + selfId, logger: (event, data) => logs.push({ event, ...data }) });
    return { service, store, state, calls, logs, handlers, receipt, directory, mediaDirectory, storeDirectory };
}
function noSideEffects(f) {
    assert.deepEqual(f.calls, []);
    assert.deepEqual(fs.readdirSync(f.mediaDirectory), []);
    assert.deepEqual(fs.readdirSync(f.storeDirectory), []);
}

test('formal group merge accepts AstrBot default thirty mixed nodes and returns a durable private OneBot mapping', async t => {
    const f = fixture(t), original = request(mixed()), saved = JSON.stringify(original);
    const result = await f.service.action(original);
    assert.equal(result.status, 'ok'); assert.equal(result.retcode, 0);
    assert.deepEqual(result.echo, original.echo);
    assert.deepEqual(Object.keys(result.data), ['message_id']);
    assert.ok(Number.isInteger(result.data.message_id) && result.data.message_id > 0 && result.data.message_id <= 0x7fffffff);
    assert.equal(f.calls.filter(call => call.method === 'prepareMedia').length, 15);
    assert.equal(f.calls.filter(call => call.method === 'resolve').length, 0);
    assert.deepEqual(f.calls.map(call => call.method), [...new Array(15).fill('prepareMedia'), 'forwardOperation']);
    const submissions = f.calls.filter(call => call.method === 'forwardOperation');
    assert.equal(submissions.length, 1);
    const submitted = submissions[0].params;
    assert.equal(submitted.kind, 'customMerge');
    assert.deepEqual(submitted.destination, { chatType: 2, peerUid: GROUP });
    assert.equal(submitted.expectedEpoch, f.state.epoch);
    assert.equal(submitted.nodes.length, 30);
    assert.ok(submitted.timeoutMs > 10000 && submitted.timeoutMs <= 60000);
    for (let index = 0; index < submitted.nodes.length; index++) {
        assert.equal(submitted.nodes[index].nickname, original.params.messages[index].data.nickname);
        const types = submitted.nodes[index].elements.map(element => element.elementType);
        assert.deepEqual(types, index % 2 === 0 ? [1] : [2, 1]);
        assert.equal(submitted.nodes[index].elements.at(-1).textElement.content,
            original.params.messages[index].data.content.at(-1).data.text);
    }
    assert.equal(JSON.stringify(submitted).includes('base64://'), false);
    assert.equal(JSON.stringify(original), saved);
    assert.deepEqual(fs.readdirSync(f.mediaDirectory), []);
    const restored = new MessageStore({ directory: f.storeDirectory }).get(SELF, result.data.message_id);
    assert.equal(restored.locator.nativeId, NATIVE_ID);
    assert.deepEqual(restored.locator.peer, { chatType: 2, peerUid: GROUP });
    assert.equal(restored.record.senderUid, f.state.self.uid);
    for (const privateValue of [NATIVE_ID, 'complete-test-resource', '/private/QQ/', f.mediaDirectory,
        'private-token-must-not-return', 'base64://']) assert.equal(JSON.stringify(result).includes(privateValue), false);
    assert.deepEqual(f.logs, []);
});

test('formal private merge resolves the exact destination UIN and accepts canonical mixed custom nodes', async t => {
    const f = fixture(t), result = await f.service.action(request([node([image(), text('  私聊\n ')])], true, 'private-echo'));
    assert.equal(result.retcode, 0); assert.equal(result.echo, 'private-echo');
    assert.deepEqual(f.calls.map(call => call.method), ['resolve', 'prepareMedia', 'forwardOperation']);
    assert.equal(f.calls[0].params.uin, USER);
    const submitted = f.calls.at(-1).params;
    assert.deepEqual(submitted.destination, { chatType: 1, peerUid: 'u_destination' });
    assert.equal(submitted.nodes[0].elements[1].textElement.content, '  私聊\n ');
    assert.deepEqual(new MessageStore({ directory: f.storeDirectory }).get(SELF, result.data.message_id).locator.peer,
        { chatType: 1, peerUid: 'u_destination' });
    assert.deepEqual(fs.readdirSync(f.mediaDirectory), []);
});

test('original plugin name, uin, time and content nodes retain every author and time through customResourceMerge', async t => {
    for (const privateTarget of [false, true]) {
        const f = fixture(t); f.state.capabilities.mergeCustomMetadata = true;
        const messages = [
            { type: 'node', data: { name: '  原作者😀  ', uin: 3000000002, time: '1700000001', content: [text('  original\n\n'), image(), text('tail')] } },
            { type: 'node', data: { name: '本人默认时间', uin: SELF, time: 0, content: '  zero-time\n\n' } },
            { type: 'node', data: { name: '同作者未指定时间', uin: '3000000002', content: [text('missing-time')] } },
            node([text('canonical self')], SELF, '本人规范字段')
        ];
        const original = request(messages, privateTarget, { plugin: 'anti-revoke', privateTarget }), saved = structuredClone(original);
        const result = await f.service.action(original);
        assert.equal(result.retcode, 0); assert.equal(result.status, 'ok');
        assert.deepEqual(result.echo, original.echo); assert.deepEqual(Object.keys(result.data), ['message_id']);
        assert.deepEqual(original, saved);
        assert.deepEqual(f.calls.map(call => call.method), [...(privateTarget ? ['resolve'] : []), 'prepareMedia', 'forwardOperation']);
        if (privateTarget) assert.equal(f.calls[0].params.uin, USER);
        const submitted = f.calls.at(-1).params;
        assert.equal(submitted.kind, 'customResourceMerge');
        assert.equal(submitted.expectedEpoch, f.state.epoch);
        assert.deepEqual(submitted.destination, { chatType: privateTarget ? 1 : 2, peerUid: privateTarget ? 'u_destination' : GROUP });
        assert.deepEqual(submitted.nodes.map(({ authorUin, nickname, time }) => ({ authorUin, nickname, time })), [
            { authorUin: '3000000002', nickname: '  原作者😀  ', time: 1700000001 },
            { authorUin: SELF, nickname: '本人默认时间', time: 0 },
            { authorUin: '3000000002', nickname: '同作者未指定时间', time: undefined },
            { authorUin: SELF, nickname: '本人规范字段', time: undefined }
        ]);
        assert.equal(Object.hasOwn(submitted.nodes[2], 'time'), false);
        assert.equal(Object.hasOwn(submitted.nodes[3], 'time'), false);
        assert.deepEqual(submitted.nodes.map(node => node.elements.map(element => element.elementType)), [[1, 2, 1], [1], [1], [1]]);
        assert.deepEqual(submitted.nodes.map(node => node.elements.filter(element => element.elementType === 1).map(element => element.textElement.content)),
            [['  original\n\n', 'tail'], ['  zero-time\n\n'], ['missing-time'], ['canonical self']]);
        const restored = new MessageStore({ directory: f.storeDirectory }).get(SELF, result.data.message_id);
        assert.equal(restored.locator.nativeId, NATIVE_ID); assert.deepEqual(restored.locator.peer, submitted.destination);
        assert.deepEqual(fs.readdirSync(f.mediaDirectory), []);
        for (const privateValue of [NATIVE_ID, 'complete-test-resource', '/private/QQ/', 'private-token-must-not-return', PNG]) {
            assert.equal(JSON.stringify(result).includes(privateValue), false);
        }
    }
});

test('explicit zero and positive self times each select the metadata runtime while missing self time uses the original branch', async t => {
    for (const time of [0, 1700000001, undefined]) {
        const f = fixture(t); f.state.capabilities.mergeCustomMetadata = true;
        const message = node([text('same self node')]);
        if (time !== undefined) message.data.time = time;
        const result = await f.service.action(request([message]));
        assert.equal(result.retcode, 0);
        assert.deepEqual(f.calls.map(call => call.method), ['forwardOperation']);
        const submitted = f.calls[0].params;
        assert.equal(submitted.kind, time === undefined ? 'customMerge' : 'customResourceMerge');
        assert.equal(Object.hasOwn(submitted.nodes[0], 'authorUin'), time !== undefined);
        assert.equal(Object.hasOwn(submitted.nodes[0], 'time'), time !== undefined);
        if (time !== undefined) { assert.equal(submitted.nodes[0].authorUin, SELF); assert.equal(submitted.nodes[0].time, time); }
    }
});

test('absent or false metadata capability rejects custom authors and every explicit time before resolution or imports', async t => {
    for (const available of [undefined, false]) for (const mode of ['other-author', 'zero-time', 'positive-time']) {
        const f = fixture(t);
        if (available !== undefined) f.state.capabilities.mergeCustomMetadata = available;
        const message = node([image(), text('never prepared')], mode === 'other-author' ? '3000000002' : SELF);
        if (mode !== 'other-author') message.data.time = mode === 'zero-time' ? 0 : 1700000001;
        const result = await f.service.action(request([node(), message], true));
        assert.equal(result.retcode, 1404); assert.equal(result.data, null);
        noSideEffects(f);
        assert.equal(f.logs.at(-1).code, 'UNSUPPORTED');
    }
    for (const available of [undefined, false]) {
        const f = fixture(t);
        if (available !== undefined) f.state.capabilities.mergeCustomMetadata = available;
        assert.equal((await f.service.action(request([node()]))).retcode, 0);
        assert.equal(f.calls[0].params.kind, 'customMerge');
        assert.equal(Object.hasOwn(f.calls[0].params.nodes[0], 'authorUin'), false);
    }
});

test('metadata capability cannot replace the general merge or image prerequisites', async t => {
    for (const mode of ['merge', 'image', 'directory']) {
        const f = fixture(t); f.state.capabilities.mergeCustomMetadata = true;
        if (mode === 'merge') f.state.capabilities.mergeCustom = false;
        if (mode === 'image') f.state.capabilities.image = false;
        if (mode === 'directory') f.service.mediaDirectory = null;
        const message = node([image()], '3000000002'); message.data.time = 0;
        const result = await f.service.action(request([message], true));
        assert.equal(result.retcode, 1404); assert.equal(result.data, null); noSideEffects(f);
    }
});

test('metadata sends require the custom resource delivery proof and never accept another runtime confirmation', async t => {
    for (const confirmation of ['fresh-source-tuple-and-resource-readback', 'fixed-longmsg-resource-and-semantic-readback', 'kernel_ack', undefined]) {
        const f = fixture(t); f.state.capabilities.mergeCustomMetadata = true;
        f.handlers.forwardOperation = params => ({ ...f.receipt(params), confirmation });
        const message = node([image(), text('metadata')], '3000000002'); message.data.time = 1700000001;
        const result = await f.service.action(request([message]));
        assert.equal(result.retcode, 1500); assert.equal(result.status, 'failed'); assert.equal(result.data, null);
        assert.deepEqual(f.calls.map(call => call.method), ['prepareMedia', 'forwardOperation']);
        assert.equal(f.calls.at(-1).params.kind, 'customResourceMerge');
        assert.deepEqual(fs.readdirSync(f.storeDirectory), []); assert.deepEqual(fs.readdirSync(f.mediaDirectory), []);
        assert.equal(JSON.stringify(result).includes('complete-test-resource'), false);
    }
});

test('invalid final plugin time rejects the complete metadata batch before preparing earlier image nodes', async t => {
    for (const time of [null, '', -1, '01700000001', '1700000001.0', 4294967296]) {
        const f = fixture(t); f.state.capabilities.mergeCustomMetadata = true;
        const messages = [node([image()], '3000000002'), { type: 'node', data: { name: 'bad time', uin: SELF, time, content: 'bad' } }];
        const result = await f.service.action(request(messages, true));
        assert.equal(result.retcode, 1400); assert.equal(result.data, null); noSideEffects(f);
    }
});

test('a metadata delivery after an account epoch change cannot publish its OneBot mapping or retry', async t => {
    const f = fixture(t); f.state.capabilities.mergeCustomMetadata = true;
    f.handlers.forwardOperation = params => { const result = f.receipt(params); f.state.epoch = 'different-epoch'; return result; };
    const message = node([image()], '3000000002'); message.data.time = 0;
    const result = await f.service.action(request([message]));
    assert.equal(result.retcode, 1503); assert.equal(result.data, null);
    assert.deepEqual(f.calls.map(call => call.method), ['prepareMedia', 'forwardOperation']);
    assert.equal(f.calls.at(-1).params.kind, 'customResourceMerge');
    assert.deepEqual(fs.readdirSync(f.storeDirectory), []); assert.deepEqual(fs.readdirSync(f.mediaDirectory), []);
});

test('the sender can query its completed native multimsg Ark root and read actual nodes through the opaque forward handle', async t => {
    const f = fixture(t), contents = ['  first node\n ', ' second & [literal]\n\n'];
    const names = ['📊 第一个报告', '  第二个报告  '];
    let actualRoot;
    f.handlers.forwardOperation = params => {
        if (params.kind === 'customMerge') {
            const result = f.receipt(params);
            result.record.elements = [{ elementType: 10, arkElement: { bytesData: JSON.stringify({
                app: 'com.tencent.multimsg', meta: { detail: { resid: result.resId, news: [] } }
            }) } }];
            actualRoot = structuredClone(result.record);
            return result;
        }
        assert.equal(params.kind, 'read');
        assert.equal(params.rootMsgId, NATIVE_ID);
        assert.equal(params.parentMsgId, NATIVE_ID);
        assert.equal(params.resId, 'complete-test-resource');
        assert.deepEqual(params.peer, { chatType: 2, peerUid: GROUP });
        return { peer: params.peer, rootMsgId: NATIVE_ID, parentMsgId: NATIVE_ID, resId: params.resId,
            records: contents.map((content, index) => ({ chatType: 2, peerUid: GROUP,
                msgId: String(BigInt(NATIVE_ID) - BigInt(index + 1)), msgTime: '1794710400',
                senderUin: SELF, senderUid: f.state.self.uid, sendNickName: names[index],
                elements: [{ elementType: 1, textElement: { content, atType: 0 } }] })) };
    };
    f.handlers.getMessage = params => {
        assert.equal(params.nativeId, NATIVE_ID);
        assert.deepEqual(params.peer, { chatType: 2, peerUid: GROUP });
        return structuredClone(actualRoot);
    };
    const sent = await f.service.action(request(contents.map((content, index) => node([text(content)], SELF, names[index]))));
    assert.equal(sent.retcode, 0);
    const queried = await f.service.action({ action: 'get_msg', params: { message_id: sent.data.message_id }, echo: 'read-root' });
    assert.equal(queried.retcode, 0); assert.equal(queried.echo, 'read-root');
    assert.equal(queried.data.message_id, sent.data.message_id);
    assert.equal(queried.data.message.length, 1); assert.equal(queried.data.message[0].type, 'forward');
    const handle = queried.data.message[0].data.id;
    assert.match(handle, /^fwd_[A-Za-z0-9_-]{32}$/);
    assert.equal(JSON.stringify(queried).includes('com.tencent.multimsg'), false);
    const nodes = await f.service.action({ action: 'get_forward_msg', params: { id: handle } });
    assert.equal(nodes.retcode, 0);
    assert.deepEqual(nodes.data.message, contents.map((content, index) => ({ type: 'node', data: {
        user_id: SELF, nickname: names[index], time: 1794710400, content: [text(content)]
    } })));
    assert.deepEqual(nodes.data.messages.map(message => message.sender.nickname), names);
    assert.deepEqual(nodes.data.messages.map(message => message.time), [1794710400, 1794710400]);
    const extended = await f.service.action({ action: 'qqapi_get_forward_messages', params: { message_id: sent.data.message_id } });
    assert.equal(extended.retcode, 0);
    assert.deepEqual(extended.data.message, nodes.data.message);
    assert.equal(f.calls.filter(call => call.method === 'getMessage').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'forwardOperation' && call.params.kind === 'customMerge').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'forwardOperation' && call.params.kind === 'read').length, 2);
});

test('the complete batch is rejected before imports, preparations, resolution or staging when any node is unsupported', async t => {
    for (const bad of [node([{ type: 'video', data: { file: 'forbidden.mp4' } }]),
        node([image()], '3000000002'), { type: 'node', data: { id: 1 } },
        node([{ type: 'image', data: { file: '/private/QQ/escape.png' } }])]) {
        const f = fixture(t), messages = [...mixed().slice(0, 29), bad];
        const result = await f.service.action(request(messages, true));
        assert.equal(result.retcode, 1404); assert.equal(result.data, null);
        noSideEffects(f);
    }
    const f = fixture(t), malformed = request(mixed());
    malformed.params.messages.at(-1).data.uin = '3000000002';
    assert.equal((await f.service.action(malformed)).retcode, 1400);
    noSideEffects(f);
});

test('missing merged capability or required image support never degrades to ordinary sends', async t => {
    for (const mode of ['merge', 'image', 'directory']) {
        const f = fixture(t);
        if (mode === 'merge') f.state.capabilities.mergeCustom = false;
        if (mode === 'image') f.state.capabilities.image = false;
        if (mode === 'directory') f.service.mediaDirectory = null;
        const result = await f.service.action(request([node([image()])], true));
        assert.equal(result.retcode, 1404); assert.equal(result.data, null);
        noSideEffects(f);
    }
});

test('private UID resolution rejects mismatched, missing or malformed mappings before any media or merge writes', async t => {
    for (const resolved of [undefined, {}, { uin: '3000000002', uid: 'u_destination' },
        { uin: USER, uid: USER }, { uin: USER, uid: 'u_' }, { uin: USER, uid: 'u_bad/uid' }]) {
        const f = fixture(t); f.handlers.resolve = () => resolved;
        const result = await f.service.action(request([node([image()])], true));
        assert.equal(result.retcode, 1404); assert.equal(result.data, null);
        assert.deepEqual(f.calls.map(call => call.method), ['resolve']);
        assert.deepEqual(fs.readdirSync(f.mediaDirectory), []);
        assert.deepEqual(fs.readdirSync(f.storeDirectory), []);
    }
});

test('destination and session boundaries cannot be overridden using alternate parameters', async t => {
    const invalid = [params => { params.user_id = USER; }, params => { params.group_id = '0'; },
        params => { params.group_id = '4294967296'; }, params => { params.group_id = Number.MAX_SAFE_INTEGER; },
        params => { params.source = { chatType: 1, peerUid: 'u_other' }; }, params => { params.self_id = '3000000002'; }];
    for (const change of invalid) {
        const f = fixture(t), action = request(); change(action.params);
        assert.equal((await f.service.action(action)).retcode, 1400);
        noSideEffects(f);
    }
    const f = fixture(t);
    assert.equal((await f.service.action(request(), { epoch: 'old-epoch', selfUin: SELF })).retcode, 1503);
    noSideEffects(f);
});

test('strict delivery metadata rejects unknown results, wrong targets, authors, IDs or resources without allocating an ID', async t => {
    const variants = [
        ['void', () => undefined], ['kernel-ack-only', () => ({ result: 0 })],
        ['not-confirmed', result => ({ ...result, confirmed: false })],
        ['wrong-proof', result => ({ ...result, confirmation: 'kernel_ack' })],
        ['wrong-destination', result => ({ ...result, destination: { chatType: 1, peerUid: 'u_other' } })],
        ['wrong-count', result => ({ ...result, nodeCount: 2 })],
        ['empty-resource', result => ({ ...result, resId: '' })],
        ['different-resource', result => ({ ...result, resId: 'substituted-resource' })],
        ['missing-record', result => ({ ...result, record: undefined })],
        ['unconfirmed-record', result => ({ ...result, record: { ...result.record, sendStatus: 1 } })],
        ['wrong-sender-uid', result => ({ ...result, record: { ...result.record, senderUid: 'u_other' } })],
        ['wrong-sender-uin', result => ({ ...result, record: { ...result.record, senderUin: '3000000002' } })],
        ['record-other-peer', result => ({ ...result, record: { ...result.record, peerUid: '1234' } })],
        ['record-id-mismatch', result => ({ ...result, record: { ...result.record, msgId: '18446744073709551002' } })],
        ['number-id', result => ({ ...result, messageId: 123, record: { ...result.record, msgId: 123 } })],
        ...['', '0', 'not-a-native-id', '18446744073709551616'].map(value => ['invalid-native-id-' + value,
            result => ({ ...result, messageId: value, record: { ...result.record, msgId: value } })])
    ];
    for (const [label, transform] of variants) {
        const f = fixture(t); f.handlers.forwardOperation = params => transform(f.receipt(params));
        const response = await f.service.action(request());
        assert.equal(response.status, 'failed', label); assert.equal(response.retcode, 1500, label);
        assert.equal(response.data, null, label);
        assert.equal(f.calls.filter(call => call.method === 'forwardOperation').length, 1, label);
        assert.deepEqual(fs.readdirSync(f.storeDirectory), [], label);
        assert.deepEqual(fs.readdirSync(f.mediaDirectory), [], label);
        assert.equal(JSON.stringify(response).includes('/private/QQ/'), false, label);
        assert.equal(JSON.stringify(response).includes('private-token-must-not-return'), false, label);
    }
});

test('unknown preparation or merge outcomes are not retried and remove only their temporary image imports', async t => {
    for (const failingMethod of ['prepareMedia', 'forwardOperation']) {
        const f = fixture(t);
        const retained = path.join(f.mediaDirectory, 'unrelated-account-resource');
        fs.writeFileSync(retained, 'keep');
        f.handlers[failingMethod] = () => { throw Object.assign(new Error('QQ operation outcome is unknown'), { code: 'TIMEOUT' }); };
        const response = await f.service.action(request([node([image(), text('test')])], false, 'timeout-echo'));
        assert.equal(response.retcode, 1504); assert.equal(response.echo, 'timeout-echo'); assert.equal(response.data, null);
        assert.equal(f.calls.filter(call => call.method === failingMethod).length, 1);
        if (failingMethod === 'prepareMedia') assert.equal(f.calls.filter(call => call.method === 'forwardOperation').length, 0);
        assert.deepEqual(fs.readdirSync(f.mediaDirectory), ['unrelated-account-resource']);
        assert.equal(fs.readFileSync(retained, 'utf8'), 'keep');
        assert.deepEqual(fs.readdirSync(f.storeDirectory), []);
        assert.equal(f.logs.at(-1).action, 'send_group_forward_msg');
        assert.equal(f.logs.at(-1).code, 'TIMEOUT');
        assert.equal(JSON.stringify(f.logs).includes('/private/QQ/'), false);
        assert.equal(JSON.stringify(f.logs).includes('base64://'), false);
    }
});

test('a confirmation arriving after the outer deadline cannot publish an ID or trigger another merge', async t => {
    const f = fixture(t, { mediaActionTimeoutMs: 50 });
    f.handlers.forwardOperation = async params => {
        await new Promise(resolve => setTimeout(resolve, 80));
        return f.receipt(params);
    };
    const result = await f.service.action(request());
    assert.equal(result.retcode, 1504); assert.equal(result.data, null);
    assert.equal(f.calls.filter(call => call.method === 'forwardOperation').length, 1);
    assert.deepEqual(fs.readdirSync(f.storeDirectory), []);
});

test('session changes during media preparation stop the entire batch before staging and clean its imports', async t => {
    const f = fixture(t);
    f.handlers.prepareMedia = () => {
        f.state.epoch = 'new-session';
        return { elementType: 2, picElement: { sourcePath: '/private/QQ/native-cache' } };
    };
    const result = await f.service.action(request([node([image()]), node([text('second')])]));
    assert.equal(result.retcode, 1503); assert.equal(result.data, null);
    assert.deepEqual(f.calls.map(call => call.method), ['prepareMedia']);
    assert.deepEqual(fs.readdirSync(f.mediaDirectory), []);
    assert.deepEqual(fs.readdirSync(f.storeDirectory), []);
});

test('two accounts merge concurrently while their preparation paths, confirmations, echoes and persistent mappings stay isolated', { timeout: 3000 }, async t => {
    const alpha = fixture(t), beta = fixture(t, { selfId: '3000000002' });
    let waiting = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    for (const f of [alpha, beta]) f.handlers.forwardOperation = async params => {
        if (++waiting === 2) release();
        await barrier;
        return f.receipt(params);
    };
    const [left, right] = await Promise.all([
        alpha.service.action(request([node([image(), text(' A\n')])], false, { profile: 'alpha' })),
        beta.service.action(request([node([image(), text(' B\n')], beta.state.self.uin)], false, { profile: 'beta' }))
    ]);
    assert.equal(left.retcode, 0); assert.equal(right.retcode, 0);
    assert.deepEqual(left.echo, { profile: 'alpha' }); assert.deepEqual(right.echo, { profile: 'beta' });
    assert.notEqual(alpha.calls[0].params.file, beta.calls[0].params.file);
    const leftEntry = new MessageStore({ directory: alpha.storeDirectory }).get(SELF, left.data.message_id);
    const rightEntry = new MessageStore({ directory: beta.storeDirectory }).get(beta.state.self.uin, right.data.message_id);
    assert.equal(leftEntry.locator.nativeId, NATIVE_ID); assert.equal(rightEntry.locator.nativeId, NATIVE_ID);
    assert.equal(leftEntry.record.senderUid, alpha.state.self.uid); assert.equal(rightEntry.record.senderUid, beta.state.self.uid);
    assert.equal(alpha.store.get(beta.state.self.uin, right.data.message_id), null);
    assert.equal(beta.store.get(SELF, left.data.message_id), null);
    assert.deepEqual(fs.readdirSync(alpha.mediaDirectory), []); assert.deepEqual(fs.readdirSync(beta.mediaDirectory), []);
});
