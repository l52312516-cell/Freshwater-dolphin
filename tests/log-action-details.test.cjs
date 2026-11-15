'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalize, LogReader } = require('../src/manager/logs.cjs');

function row(extra = {}) {
    return { id: 'synthetic-action-log', time: '2026-11-14T12:00:00.000Z', event: 'action_failed',
        action: 'get_group_msg_history', stage: 'history', durationMs: 23, code: 'INVALID_RESPONSE', ...extra };
}
function fixture(t, records) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'action-log-details-'));
    const location = path.join(root, 'work/accounts/alpha'); fs.mkdirSync(path.join(location, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(location, 'logs/adapter.jsonl'), records.map(value => JSON.stringify(value)).join('\n') + '\n');
    const accounts = { document: { profiles: [{ id: 'alpha' }] }, location: () => location,
        get: id => { if (id !== 'alpha') throw new Error('Unknown profile'); return { id }; } };
    const reader = new LogReader(root, accounts);
    t.after(() => { reader.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return reader;
}

test('action failure logs retain action, stage and duration and clearly identify an API failure', () => {
    const output = normalize(row(), 'alpha', true);
    assert.equal(output.action, 'get_group_msg_history'); assert.equal(output.stage, 'history');
    assert.equal(output.durationMs, 23); assert.equal(output.code, 'INVALID_RESPONSE');
    assert.equal(output.level, 'ERROR'); assert.equal(output.component, 'onebot');
    for (const value of ['接口调用失败', 'action_failed', 'action=get_group_msg_history', 'stage=history',
        'code=INVALID_RESPONSE', 'durationMs=23', 'QQ 返回结果缺失']) assert.ok(output.message.includes(value));
    assert.equal(output.message.includes('入站消息已跳过'), false);
});

test('a safe fixed reason identifier survives without accepting arbitrary error text or payloads', () => {
    const output = normalize(row({ reason: 'unsupported_media', message: 'original private chat',
        wording: 'private wording', error: { message: 'private native error' }, errorMessage: 'private native error',
        token: 'sensitive-access-token', url: 'https://example.invalid/file?rkey=private-signature',
        stack: 'private stack', content: 'private body', params: { message: 'private request' } }), 'alpha', true);
    assert.equal(output.reason, 'unsupported_media'); assert.ok(output.message.includes('reason=unsupported_media'));
    for (const value of ['original private chat', 'private wording', 'private native error', 'sensitive-access-token',
        'private-signature', 'private stack', 'private body', 'private request', 'example.invalid']) {
        assert.equal(JSON.stringify(output).includes(value), false);
    }
});

test('untrusted action context cannot inject text, URLs or controls into diagnostic output', () => {
    for (const value of ['https://example.invalid/private?token=secret', 'private body with spaces', 'a\nb',
        '<script>secret</script>', 'x'.repeat(101), {}, [], null, true, 12]) {
        const output = normalize(row({ action: value, stage: value, reason: value }), 'alpha', true);
        for (const field of ['action', 'stage', 'reason']) assert.equal(Object.hasOwn(output, field), false);
    }
    for (const durationMs of [-1, NaN, Infinity, '25', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(Object.hasOwn(normalize(row({ durationMs }), 'alpha', true), 'durationMs'), false);
    }
    assert.equal(normalize(row({ durationMs: 0 }), 'alpha', true).durationMs, 0);
});

test('action error explanations are fixed safe descriptions of actual error categories', () => {
    const cases = { INVALID_REQUEST: '请求参数', NOT_FOUND: '本账号的消息定位不存在', NOT_READY: '尚未就绪',
        SESSION_CHANGED: '会话已经变更', TIMEOUT: '请勿自动重试', EXPIRED: '请勿自动重试',
        KERNEL_ERROR: 'QQ 拒绝请求', PARTIAL_RESULT: '未自动补发', QUERY_LIMIT: '分页或容量限制' };
    for (const [code, expected] of Object.entries(cases)) {
        const output = normalize(row({ code }), 'alpha', true);
        assert.ok(output.message.includes(expected), code);
    }
    assert.ok(normalize(row({ code: 'NEW_UNKNOWN_FAILURE' }), 'alpha', true).message.includes('处理阶段和错误码'));
});

test('skipped incoming messages, requests and notices are visibly distinct from failed API calls', () => {
    for (const [event, label] of [['message_skipped', '入站消息已跳过'],
        ['request_skipped', '入站申请事件已跳过'], ['notice_skipped', '入站通知已跳过']]) {
        const output = normalize(row({ event, code: 'UNSUPPORTED', action: undefined, stage: undefined, durationMs: undefined }), 'alpha', true);
        assert.equal(output.level, 'WARN'); assert.equal(output.component, 'worker');
        assert.ok(output.message.includes(label)); assert.ok(output.message.includes(event));
        assert.equal(output.message.includes('接口调用失败'), false);
    }
});

test('invalid incoming events describe inbound identity or structure validation rather than API parameters', () => {
    for (const event of ['message_skipped', 'request_skipped', 'notice_skipped']) {
        for (const code of ['INVALID_REQUEST', 'INVALID_PARAMS']) {
            const output = normalize(row({ event, code }), 'alpha', true);
            assert.ok(output.message.includes('入站事件的身份或结构未通过校验'));
            assert.equal(output.message.includes('请求参数'), false);
        }
    }
    assert.ok(normalize(row({ code: 'INVALID_REQUEST' }), 'alpha', true).message.includes('请求参数'));
});

test('fixed incoming reason identifiers provide safe specific explanations with no arbitrary error text', () => {
    const reasons = { unsupported_gray_tip: '尚未支持的群系统提示', invalid_gray_tip: '群系统提示的结构',
        invalid_poke: '戳一戳通知的身份或结构', identity_mapping: 'QQ 号与 UID',
        event_session: '当前 QQ 账号或会话不匹配', stale_event: '入站事件已失效' };
    for (const [reason, expected] of Object.entries(reasons)) {
        const output = normalize(row({ event: 'notice_skipped', code: 'INVALID_REQUEST', reason,
            errorMessage: 'do-not-log-native-text', content: 'do-not-log-chat-body' }), 'alpha', true);
        assert.ok(output.message.includes(expected), reason); assert.ok(output.message.includes('reason=' + reason));
        assert.equal(output.message.includes('请求参数'), false);
        assert.equal(JSON.stringify(output).includes('do-not-log'), false);
    }
    assert.ok(normalize(row({ event: 'notice_skipped', reason: 'unrecognized_reason', code: 'INVALID_PARAMS' }),
        'alpha', true).message.includes('入站事件的身份或结构未通过校验'));
});

test('received poke notices display only fixed stage and validated account identifiers', () => {
    const output = normalize({ time: row().time, event: 'notice_received', stage: 'poke',
        userId: 12345, targetId: '23456', groupId: '34567', selfId: 45678,
        content: 'private incoming body', token: 'do-not-log-token',
        url: 'https://example.invalid/private?rkey=do-not-log-signature' }, 'alpha', true);
    assert.equal(output.profileId, 'alpha'); assert.equal(output.level, 'SUCCESS'); assert.equal(output.component, 'onebot');
    for (const [key, expected] of Object.entries({ userId: '12345', targetId: '23456', groupId: '34567', selfId: '45678' })) {
        assert.equal(output[key], expected); assert.ok(output.message.includes(key + '=' + expected));
    }
    assert.ok(output.message.includes('收到戳一戳通知')); assert.ok(output.message.includes('stage=poke'));
    assert.equal(JSON.stringify(output).includes('private'), false); assert.equal(JSON.stringify(output).includes('do-not-log'), false);
    assert.equal(Object.hasOwn(output, 'content'), false);
});

test('diagnostic account metadata rejects inexact IDs, objects, control characters and signed URLs', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '01', '123\n456',
        '12345?token=secret', 'https://example.invalid?token=secret', {}, [], null, true, '1'.repeat(17)]) {
        const output = normalize({ time: row().time, event: 'notice_received', stage: 'poke',
            userId: value, targetId: value, groupId: value, selfId: value }, 'alpha', true);
        for (const key of ['userId', 'targetId', 'groupId', 'selfId']) assert.equal(Object.hasOwn(output, key), false);
        assert.equal(output.message, '收到戳一戳通知（notice_received） · stage=poke');
    }
    const unknown = normalize({ time: row().time, event: 'notice_received', stage: 'new_notice' }, 'alpha', true);
    assert.ok(unknown.message.startsWith('收到通知（notice_received）'));
});

test('safe received notice metadata remains searchable and exportable without raw notification data', t => {
    const reader = fixture(t, [{ time: row().time, event: 'notice_received', stage: 'poke',
        userId: '12345', targetId: '23456', selfId: '34567', token: 'never-return-token',
        message: 'never-return-raw-notice', content: 'never-return-chat' }]);
    const output = reader.read({ query: '23456', includeContent: false, component: 'onebot', level: 'SUCCESS' });
    assert.equal(output.length, 1); assert.equal(output[0].targetId, '23456');
    assert.ok(output[0].message.includes('收到戳一戳通知'));
    assert.equal(JSON.stringify(output).includes('never-return'), false);
});

test('existing diagnostic records without action metadata remain readable without inventing an action', () => {
    const output = normalize({ time: row().time, event: 'action_failed', code: 'INVALID_REQUEST' }, 'alpha', true);
    assert.ok(output.message.includes('接口调用失败')); assert.ok(output.message.includes('请求参数'));
    assert.equal(Object.hasOwn(output, 'action'), false); assert.equal(Object.hasOwn(output, 'stage'), false);
    const unrelated = normalize({ time: row().time, event: 'connected', connected: true, nodeId: 'astrbot' }, 'alpha', true);
    assert.equal(unrelated.message, 'connected connected=true nodeId=astrbot'); assert.equal(unrelated.component, 'worker');
});

test('reader restores action details from old diagnostic files and supports action or stage searches', t => {
    const reader = fixture(t, [row(), row({ id: 'other-action-row', action: 'get_msg', stage: 'getMessage', code: 'NOT_FOUND',
        time: '2026-11-14T12:00:01.000Z' })]);
    const history = reader.read({ query: 'get_group_msg_history', component: 'onebot', level: 'ERROR' });
    assert.equal(history.length, 1); assert.equal(history[0].stage, 'history');
    assert.equal(reader.read({ query: 'getMessage' }).length, 1);
    assert.ok(reader.read({ query: 'NOT_FOUND' })[0].message.includes('本账号的消息定位不存在'));
});

test('diagnostic exports keep safe action context while excluding arbitrary native messages and private bodies', t => {
    const reader = fixture(t, [row({ token: 'never-export-token', message: 'never-export-native-error',
        content: 'never-export-private-message', url: 'https://example.invalid/private?rkey=never-export-signature' })]);
    const exported = reader.read({ includeContent: false });
    assert.equal(exported.length, 1); assert.equal(exported[0].action, 'get_group_msg_history');
    assert.equal(exported[0].stage, 'history'); assert.equal(exported[0].durationMs, 23);
    for (const text of ['never-export-token', 'never-export-native-error', 'never-export-private-message', 'never-export-signature']) {
        assert.equal(JSON.stringify(exported).includes(text), false);
    }
});
