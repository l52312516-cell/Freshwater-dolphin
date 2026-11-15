'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../src/log.cjs');
const { messageContent, messageDetails, sanitizeMessageRecord, MAX_CONTENT_BYTES } = require('../src/message-log.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const { nodeConfig } = require('../src/config.cjs');

function temporary(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'message-logs-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}
function message(overrides = {}) {
    return { msgId: '18446744073709551612', msgSeq: '9007199254740993', clientSeq: '31',
        chatType: 2, peerUid: '12345', peerUin: '12345', senderUid: 'u_sender', senderUin: '22222',
        msgTime: '1800000000', sendNickName: '小海豚', sendMemberName: '群名片', groupName: '海豚群',
        elements: [{ elementType: 1, textElement: { content: '  原文 <b>\n第二行  ', atType: 0 } }], ...overrides };
}
function fixture(t) {
    const directory = temporary(t), entries = [];
    const store = new MessageStore({ directory });
    const state = { epoch: 'session-1', ready: true, online: true,
        self: { uin: '11111', uid: 'u_self', nickname: '海豚' }, capabilities: { face: true } };
    let next = 18446744073709550000n;
    const logger = () => {}; logger.message = value => entries.push(value);
    const backend = { async call(method, params = {}) {
        if (method === 'status') return state;
        if (method === 'resolve') return { uin: params.uin || '22222', uid: params.uid || 'u_' + params.uin };
        if (method === 'groupMember') return { user_id: Number(params.uin), nickname: '成员', card: '卡片' };
        if (method === 'sendMessage') return message({ msgId: String(next++), ...params.peer,
            senderUin: '11111', senderUid: 'u_self', elements: params.elements });
        throw new Error('Unexpected method ' + method);
    } };
    const service = new OneBotService({ backend, store, logger, profileId: 'alpha' });
    return { service, backend, store, state, entries };
}

test('message display preserves text exactly and replaces media metadata with fixed markers', () => {
    const raw = '  <script>alert(1)</script>\n第二行\t [CQ:image,file=literal]  ';
    const result = messageContent([{ type: 'text', data: { text: raw } }, { type: 'at', data: { qq: '22222' } },
        { type: 'at', data: { qq: 'all' } }, { type: 'reply', data: { id: '123' } }, { type: 'face', data: { id: '14' } },
        { type: 'image', data: { file: '/private/file.png', url: 'https://example.invalid/a?token=private', summary: 'private-token' } },
        { type: 'file', data: { name: 'private-filename', file: '/private/file' } }]);
    assert.equal(result.content, raw + '[@22222][@全体成员][引用 123][表情 14][图片][文件]');
    assert.equal(result.truncated, false);
    assert.equal(result.content.includes('/private/'), false);
    assert.equal(result.content.includes('private-token'), false);
});

test('message display has a UTF-8 byte bound and retains complete Unicode characters', () => {
    const text = '🐬'.repeat(20000);
    const result = messageContent([{ type: 'text', data: { text } }]);
    assert.equal(Buffer.byteLength(result.content), MAX_CONTENT_BYTES);
    assert.equal(result.content, text.slice(0, MAX_CONTENT_BYTES / 2));
    assert.equal(result.content.includes('\ufffd'), false);
    assert.equal(result.truncated, true);
});

test('private message log has a strict whitelist, stable IDs and no body in stdout or diagnostics', t => {
    const directory = temporary(t), written = [];
    const original = process.stdout.write;
    process.stdout.write = value => { written.push(String(value)); return true; };
    try {
        const logger = createLogger(directory);
        logger('test_event', { code: 'TEST', token: 'secret-token', content: 'private-body', password: 'password' });
        const details = messageDetails({ direction: 'received', profileId: 'alpha', selfId: '11111', messageId: 1,
            messageType: 'group', userId: '22222', groupId: '12345', senderName: '名字', card: '名片',
            segments: [{ type: 'text', data: { text: 'private-body\n第二行' } }] });
        logger.message({ ...details, token: 'secret-token', password: 'password', rawRecord: { arbitrary: true } });
        const diagnostics = fs.readFileSync(path.join(directory, 'adapter.jsonl'), 'utf8');
        const messages = fs.readFileSync(path.join(directory, 'messages.jsonl'), 'utf8');
        assert.equal(diagnostics.includes('private-body'), false);
        assert.equal(written.join('').includes('private-body'), false);
        assert.equal(messages.includes('secret-token'), false);
        const row = JSON.parse(messages.trim());
        assert.equal(row.content, 'private-body\n第二行'); assert.equal(row.senderName, '名字');
        assert.match(row.id, /^[a-f0-9-]{36}$/); assert.match(row.time, /Z$/);
        assert.deepEqual(sanitizeMessageRecord(row), row);
        const exported = sanitizeMessageRecord(row, { includeContent: false });
        for (const field of ['content', 'senderName', 'card', 'groupName', 'rawRecord', 'token', 'password']) assert.equal(Object.hasOwn(exported, field), false);
        assert.equal(exported.messageId, 1);
        logger.message({ ...details, profileId: '../outside' });
        logger.message({ ...details, selfId: { toString: null } });
        logger.message({ ...details, profileId: { toString: null } });
        assert.equal(fs.readFileSync(path.join(directory, 'messages.jsonl'), 'utf8'), messages);
    } finally { process.stdout.write = original; }
});

test('unsupported incoming elements produce no partial original-message log', async t => {
    const { service, state, entries } = fixture(t);
    const converted = await service.event({ kind: 'message', epoch: state.epoch, selfUin: state.self.uin,
        record: message({ elements: [{ elementType: 1, textElement: { content: 'partial text', atType: 0 } },
            { elementType: 100, unknownElement: { secret: 'not for display' } }] }) });
    assert.equal(converted, null); assert.equal(entries.length, 0);
});

test('concurrent actions keep successful and timed-out message logs isolated', async t => {
    const { service, backend, entries } = fixture(t), original = backend.call;
    let started, release;
    const waiting = new Promise(resolve => { started = resolve; });
    const delayed = new Promise(resolve => { release = resolve; });
    backend.call = async (method, params) => {
        if (method === 'sendMessage' && params.elements[0]?.textElement?.content === 'uncertain') {
            started(); await delayed; throw Object.assign(new Error('unknown'), { code: 'TIMEOUT' });
        }
        return original(method, params);
    };
    const uncertain = service.action({ action: 'send_group_msg', params: { group_id: 12345, message: 'uncertain' } });
    await waiting;
    const delivered = await service.action({ action: 'send_private_msg', params: { user_id: 22222, message: 'delivered' } });
    release();
    assert.equal((await uncertain).retcode, 1504); assert.equal(delivered.retcode, 0);
    assert.equal(entries.length, 1); assert.equal(entries[0].content, 'delivered'); assert.equal(entries[0].messageType, 'private');
});

test('message files rotate before overflow without adding unbounded backups', t => {
    const directory = temporary(t), logger = createLogger(directory, { maxBytes: 1100, backups: 2 });
    for (let index = 1; index <= 8; index++) logger.message(messageDetails({ direction: 'sent', profileId: 'alpha', selfId: '11111',
        messageId: index, messageType: 'private', userId: '11111', peerId: '22222', segments: [{ type: 'text', data: { text: 'x'.repeat(600) } }] }));
    const files = fs.readdirSync(directory).filter(name => name.startsWith('messages.jsonl'));
    assert.deepEqual(files.sort(), ['messages.jsonl', 'messages.jsonl.1', 'messages.jsonl.2']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'messages.jsonl'), 'utf8').trim()).messageId, 8);
    for (const filename of files) assert.ok(fs.statSync(path.join(directory, filename)).size <= 1100);
});

test('accepted incoming message logs once after dedup and keeps sender/card and text structure', async t => {
    const { service, state, store, entries } = fixture(t);
    const event = { kind: 'message', epoch: state.epoch, selfUin: state.self.uin, record: message() };
    const converted = await service.event(event);
    assert.equal(converted.message_type, 'group'); assert.equal(entries.length, 1);
    assert.equal(entries[0].event, 'message_received'); assert.equal(entries[0].profileId, 'alpha');
    assert.equal(entries[0].content, '  原文 <b>\n第二行  ');
    assert.equal(entries[0].senderName, '小海豚'); assert.equal(entries[0].card, '群名片');
    assert.equal(entries[0].groupId, 12345); assert.equal(entries[0].groupName, '海豚群');
    assert.equal(await service.event(event), null); assert.equal(entries.length, 1);
    const again = new OneBotService({ backend: service.backend, store, logger: service.logger, profileId: 'alpha' });
    assert.equal(await again.event(event), null); assert.equal(entries.length, 1);
    const own = { ...event, record: message({ msgId: 'new-own-message', senderUin: '11111', senderUid: 'u_self' }) };
    assert.equal(await service.event(own), null); assert.equal(entries.length, 1);
});

test('only confirmed successful outgoing actions log content, with private target and group mentions', async t => {
    const { service, backend, entries } = fixture(t);
    const first = await service.action({ action: 'send_private_msg', params: { user_id: 22222, auto_escape: true,
        message: '  literal [CQ:at,qq=11111]\n' } });
    assert.equal(first.retcode, 0); assert.equal(entries.length, 1);
    assert.equal(entries[0].content, '  literal [CQ:at,qq=11111]\n');
    assert.equal(entries[0].event, 'message_sent'); assert.equal(entries[0].peerId, '22222');
    const sent = await service.action({ action: 'send_group_msg', params: { group_id: 12345,
        message: [{ type: 'at', data: { qq: '22222' } }, { type: 'text', data: { text: ' hello\n ' } }, { type: 'face', data: { id: 14 } }] } });
    assert.equal(sent.retcode, 0); assert.equal(entries.length, 2);
    assert.equal(entries[1].content, '[@22222] hello\n [表情 14]');
    assert.equal(entries[1].messageId, sent.data.message_id);
    const original = backend.call;
    backend.call = async (method, params) => {
        if (method === 'sendMessage') throw Object.assign(new Error('delivery unknown'), { code: 'TIMEOUT' });
        return original(method, params);
    };
    const failed = await service.action({ action: 'send_private_msg', params: { user_id: 22222, message: 'do not report sent' } });
    assert.equal(failed.retcode, 1504); assert.equal(entries.length, 2);
});

test('late confirmed send is not logged as successful when the outer deadline expires', async t => {
    const { service, store, entries } = fixture(t);
    service.actionTimeoutMs = 100;
    let mapped = false;
    const original = store.remember.bind(store);
    store.remember = (...args) => {
        const result = original(...args), until = Date.now() + service.actionTimeoutMs + 5;
        mapped = true;
        while (Date.now() < until) { /* Simulate the final synchronous mapping write crossing the deadline. */ }
        return result;
    };
    const result = await service.action({ action: 'send_group_msg', params: { group_id: 12345, message: 'confirmed too late' } });
    assert.equal(mapped, true); assert.equal(result.retcode, 1504); assert.equal(entries.length, 0);
});

test('logging failures cannot change a confirmed successful send into an error', async t => {
    const { service } = fixture(t); service.logger.message = () => { throw new Error('disk full'); };
    const result = await service.action({ action: 'send_group_msg', params: { group_id: 12345, message: 'confirmed' } });
    assert.equal(result.retcode, 0);
});

test('node labels support readable names while IDs remain stable and control characters are rejected', () => {
    assert.equal(nodeConfig({ id: 'bot', type: 'wsClient', url: 'ws://localhost/ws' }, 0).label, 'bot');
    assert.equal(nodeConfig({ id: 'bot', label: 'AstrBot · 日常', type: 'httpApi' }, 0).label, 'AstrBot · 日常');
    assert.equal(nodeConfig({ id: 'bot', name: '兼容名称', type: 'httpApi' }, 0).label, '兼容名称');
    for (const label of ['a\nb', 'a\u0000b', 'a'.repeat(101), {}]) assert.throws(() => nodeConfig({ id: 'bot', label, type: 'httpApi' }, 0), { code: 'INVALID_CONFIG' });
});
