'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { StatusCommand, normalizeStatusCommand } = require('../src/status-command.cjs');
const { atomic } = require('../src/manager/files.cjs');

function fixture(t, overrides = {}) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'status-command-'));
    let clock = 0, authorized = true;
    const state = { epoch: 'status-session', ready: true, online: true, self: { uin: '12345', uid: 'u_self' } };
    const calls = [], logs = [];
    const command = new StatusCommand({ root, status: () => state, authorizeSession: () => authorized,
        service: { action: async (request, session) => { calls.push({ request, session }); return { status: 'ok', retcode: 0 }; } },
        logger: (event, data) => logs.push({ event, data }), now: () => clock, platform: 'linux-x64', version: 'test.1', ...overrides });
    t.after(async () => { await command.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const session = () => ({ epoch: state.epoch, selfUin: state.self.uin });
    const event = (text = '#fd', extra = {}) => ({ time: 1000, self_id: Number(state.self.uin), post_type: 'message',
        message_type: 'group', message_id: 1, user_id: 54321, group_id: 98765,
        message: [{ type: 'text', data: { text } }], ...extra });
    return { root, state, calls, logs, command, session, event, settings: input => atomic(path.join(root, 'work/control/settings.json'), input),
        clock: value => { clock = value; }, authorize: value => { authorized = value; } };
}

test('status command defaults and Unicode triggers normalize without accepting ambiguous settings', () => {
    assert.deepEqual(normalizeStatusCommand(), { enabled: true, trigger: '#fd' });
    assert.deepEqual(normalizeStatusCommand({}), { enabled: true, trigger: '#fd' });
    assert.deepEqual(normalizeStatusCommand({ enabled: false, trigger: '  #FD  ' }), { enabled: false, trigger: '#fd' });
    assert.deepEqual(normalizeStatusCommand({ enabled: true, trigger: '#fw' }), { enabled: true, trigger: '#fw' });
    assert.equal(normalizeStatusCommand({ trigger: '🐬'.repeat(32) }).trigger, '🐬'.repeat(32));
    for (const value of [null, [], false, { enabled: null }, { enabled: 1 }, { trigger: null }, { trigger: '' },
        { trigger: '🐬'.repeat(33) }, { trigger: '#fd test' }, { trigger: '#f\nw' }, { trigger: '#f\u200bw' },
        { trigger: '\ud800' }, { trigger: '#fd', shell: true }]) assert.throws(() => normalizeStatusCommand(value), { code: 'INVALID_CONFIG' });
});

test('a complete pure text command consumes the event and uses the bound group action', async t => {
    const f = fixture(t); f.clock(90061000);
    assert.equal(f.command.handle(f.event('  #FD\n'), f.session()), true);
    await f.command.pending;
    assert.equal(f.calls.length, 1);
    const { request, session } = f.calls[0];
    assert.deepEqual(session, { epoch: 'status-session', selfUin: '12345' });
    assert.equal(request.action, 'send_group_msg'); assert.equal(request.params.group_id, 98765);
    assert.equal(request.params.user_id, undefined);
    assert.equal(request.params.message[0].data.text,
        'Freshwater-dolphin 状态\n版本：test.1\n平台：linux-x64\n运行时长：1天 1小时 1分钟 1秒\nQQ 状态：在线');
    assert.equal(f.logs.at(-1).event, 'status_command_sent');
});

test('private replies target the original sender and preserve unknown QQ online state', async t => {
    const f = fixture(t); f.state.online = null;
    assert.equal(f.command.handle(f.event('#fd', { message_type: 'private', group_id: undefined }), f.session()), true);
    await f.command.pending;
    assert.equal(f.calls[0].request.action, 'send_private_msg');
    assert.equal(f.calls[0].request.params.user_id, 54321); assert.equal(f.calls[0].request.params.group_id, undefined);
    assert.match(f.calls[0].request.params.message[0].data.text, /QQ 状态：未知$/);
    assert.doesNotMatch(f.calls[0].request.params.message[0].data.text, /QQ在线时长/);
});

test('only complete text messages match, including multiple adjacent text elements', async t => {
    const f = fixture(t);
    for (const message of [[], [{ type: 'at', data: { qq: '12345' } }, { type: 'text', data: { text: '#fd' } }],
        [{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '#fd' } }],
        [{ type: 'text', data: { text: '#fd' } }, { type: 'image', data: { file: 'image' } }],
        [{ type: 'text', data: { text: 'prefix #fd' } }], [{ type: 'text', data: { text: '#fd suffix' } }]]) {
        assert.equal(f.command.handle(f.event('', { message }), f.session()), false);
    }
    assert.equal(f.command.handle(f.event('', { post_type: 'notice' }), f.session()), false);
    assert.equal(f.command.handle(f.event('', { message: [{ type: 'text', data: { text: '#F' } }, { type: 'text', data: { text: 'D' } }] }), f.session()), true);
    await f.command.pending; assert.equal(f.calls.length, 1);
});

test('saved trigger and enabled changes apply immediately without worker restart', async t => {
    const f = fixture(t);
    f.settings({ statusCommand: { enabled: false, trigger: '#fd' } });
    assert.equal(f.command.handle(f.event(), f.session()), false); assert.equal(f.calls.length, 0);
    f.settings({ statusCommand: { enabled: true, trigger: '  #STATUS  ' } });
    assert.equal(f.command.handle(f.event(), f.session()), false);
    assert.equal(f.command.handle(f.event(' #Status '), f.session()), true);
    await f.command.pending; assert.equal(f.calls.length, 1);
});

test('unknown, unauthorized, crossed and self-origin identities never create a send action', async t => {
    const f = fixture(t);
    const checks = [
        () => { f.authorize(false); },
        () => { f.authorize(true); f.state.ready = false; },
        () => { f.state.ready = true; f.state.self.uid = ''; },
        () => { f.state.self.uid = 'u_self'; return { expected: { epoch: 'old-session', selfUin: '12345' } }; },
        () => ({ event: f.event('#fd', { self_id: 99999 }) }),
        () => ({ event: f.event('#fd', { user_id: 12345 }) }),
        () => ({ event: f.event('#fd', { group_id: 'invalid' }) })
    ];
    for (const setup of checks) {
        const change = setup() || {};
        assert.equal(f.command.handle(change.event || f.event(), change.expected || f.session()), true);
        await f.command.pending;
    }
    assert.equal(f.calls.length, 0);
});

test('session change and stop invalidate queued replies before any QQ action', async t => {
    const f = fixture(t);
    assert.equal(f.command.handle(f.event(), f.session()), true);
    f.state.epoch = 'new-session'; f.command.invalidate();
    await f.command.pending; assert.equal(f.calls.length, 0);
    assert.equal(f.command.handle(f.event(), f.session()), true);
    await f.command.close(); assert.equal(f.calls.length, 0);
    assert.equal(f.command.handle(f.event(), f.session()), false);
});

test('pending authentication or setting revocation cancels a reply before send', async t => {
    const f = fixture(t);
    f.command.handle(f.event(), f.session()); f.authorize(false);
    await f.command.pending; assert.equal(f.calls.length, 0);
    f.authorize(true); f.clock(40000);
    f.command.handle(f.event(), f.session()); f.settings({ statusCommand: { enabled: false, trigger: '#fd' } });
    await f.command.pending; assert.equal(f.calls.length, 0);
});

test('per-account and sender cooldowns consume spam while preserving distinct-message behavior', async t => {
    const f = fixture(t);
    f.command.handle(f.event(), f.session()); await f.command.pending;
    f.clock(1000); f.command.handle(f.event('#fd', { message_id: 2, user_id: 54322 }), f.session()); await f.command.pending;
    assert.equal(f.calls.length, 1);
    f.clock(5000); f.command.handle(f.event('#fd', { message_id: 3, user_id: 54322 }), f.session()); await f.command.pending;
    assert.equal(f.calls.length, 2);
    f.clock(10000); f.command.handle(f.event('#fd', { message_id: 4 }), f.session()); await f.command.pending;
    assert.equal(f.calls.length, 2);
    f.clock(30000); f.command.handle(f.event('#fd', { message_id: 5 }), f.session()); await f.command.pending;
    assert.equal(f.calls.length, 3);
    f.state.epoch = 'replaced-session'; f.command.invalidate();
    f.command.handle(f.event('#fd', { message_id: 6 }), f.session()); await f.command.pending;
    assert.equal(f.calls.length, 4); assert.equal(f.calls[3].session.epoch, 'replaced-session');
});

test('sender tracking and concurrency remain bounded for public group commands', async t => {
    let finish, started = 0;
    const f = fixture(t, { service: { action: async () => { started++; await new Promise(resolve => { finish = resolve; }); return { status: 'ok', retcode: 0 }; } } });
    f.command.handle(f.event(), f.session()); await Promise.resolve();
    for (let i = 0; i < 1000; i++) { f.clock(100000 + i * 5000); f.command.handle(f.event('#fd', { user_id: 60000 + i }), f.session()); }
    assert.equal(started, 1); assert.equal(f.command.senders.size, 1);
    finish(); await f.command.pending;
    f.command.service.action = async () => ({ status: 'ok', retcode: 0 });
    for (let i = 0; i < 300; i++) { f.clock(10000000 + i * 5000); f.command.handle(f.event('#fd', { user_id: 70000 + i }), f.session()); await f.command.pending; }
    assert.ok(f.command.senders.size <= 256);
});

test('failed or unknown send outcomes are logged once and never retried', async t => {
    let calls = 0;
    const f = fixture(t, { service: { action: async () => { calls++; return { status: 'failed', retcode: 1504 }; } } });
    f.command.handle(f.event(), f.session()); await f.command.pending; await Promise.resolve();
    assert.equal(calls, 1); assert.equal(f.logs.filter(item => item.event === 'status_command_failed').length, 1);
    assert.deepEqual(f.logs.find(item => item.event === 'status_command_failed').data, { retcode: 1504 });
});

test('malformed settings disable handling without exposing settings secrets or replacing files', async t => {
    const f = fixture(t);
    f.settings({ musicSignKey: 'never-log-this-key', statusCommand: { enabled: true, trigger: '#f w' } });
    assert.equal(f.command.handle(f.event(), f.session()), false);
    assert.equal(f.command.handle(f.event(), f.session()), false);
    assert.equal(f.logs.filter(item => item.event === 'status_command_config_invalid').length, 1);
    assert.ok(!JSON.stringify(f.logs).includes('never-log-this-key'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'work/control/settings.json'), 'utf8')).musicSignKey, 'never-log-this-key');
});

test('separate account workers have independent command cooldowns and exact action identities', async t => {
    const a = fixture(t), b = fixture(t);
    b.state.self = { uin: '3000000002', uid: 'u_second' }; b.state.epoch = 'second-session';
    assert.equal(a.command.handle(a.event(), a.session()), true); assert.equal(b.command.handle(b.event(), b.session()), true);
    await Promise.all([a.command.pending, b.command.pending]);
    assert.equal(a.calls.length, 1); assert.equal(b.calls.length, 1);
    assert.equal(a.calls[0].session.selfUin, '12345'); assert.equal(b.calls[0].session.selfUin, '3000000002');
});
