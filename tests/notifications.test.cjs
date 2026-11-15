'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Notifications, snapshot } = require('../src/manager/notifications.cjs');

function email(overrides = {}) {
    return { id: 'mail-1', name: '值班邮件', type: 'email', enabled: true, host: 'smtp.example.test', port: 465,
        secure: true, user: 'bot@example.test', password: 'private-smtp-password', from: 'Freshwater <bot@example.test>',
        to: ['ops@example.test'], subjectTemplate: '{event} {uin} {nickname}',
        bodyTemplate: '{profileId}|{uin}|{nickname}|{event}|{time}|{status}|{pid}|{error}', ...overrides };
}
function webhook(overrides = {}) {
    return { id: 'hook-1', name: '值班 Webhook', type: 'webhook', enabled: true,
        url: 'https://notify.example.test/private?key=secret-query', token: 'private-bearer', ...overrides };
}
function account(id = 'a', uin = '2068886823') {
    return { id, expectedUin: uin, boundUin: uin, state: 'online', desired: 'running',
        notifications: { enabled: true, channelIds: ['mail-1'] },
        health: { authorized: true, ready: true, online: true, selfId: uin, nickname: '海豚', sessionEpoch: 'first' } };
}
const settle = async () => { for (let n = 0; n < 4; n++) await new Promise(resolve => setImmediate(resolve)); };
function harness(t, options = {}) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'notifications-'));
    let now = 1700000000000, sequence = 0;
    const timers = new Map(), sent = [], accounts = [];
    const worker = new Notifications(root, { getAccounts: () => accounts,
        sendMail: async (smtp, message, signal) => { sent.push({ smtp, message, signal }); return { accepted: message.to, rejected: [] }; },
        now: () => now, setTimer: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
        clearTimer: id => timers.delete(id), ...options });
    t.after(() => { worker.close(); fs.rmSync(root, { recursive: true, force: true }); });
    function advance(ms) {
        now += ms;
        for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    }
    return { worker, root, accounts, sent, timers, advance };
}

test('notification configuration defaults, secret redaction and restart persistence', t => {
    const h = harness(t);
    assert.equal(h.worker.config().offlineDelaySeconds, 30);
    h.worker.update({ offlineDelaySeconds: 15, channels: [email(), webhook()] });
    const config = h.worker.config();
    assert.equal(config.channels[0].passwordPresent, true);
    assert.equal(config.channels[0].password, undefined);
    assert.equal(config.channels[1].tokenPresent, true);
    assert.equal(config.channels[1].urlPresent, true);
    assert.equal(config.channels[1].endpoint, 'https://notify.example.test');
    assert.equal(config.channels[1].url, undefined);
    assert.equal(config.channels[1].token, undefined);
    assert.equal(JSON.stringify(config).includes('secret-query'), false);
    h.worker.update({ offlineDelaySeconds: 10, channels: config.channels });
    const reopened = new Notifications(h.root);
    t.after(() => reopened.close());
    assert.deepEqual(reopened.config().channels, config.channels);
    assert.equal(reopened.config().offlineDelaySeconds, 10);
    const saved = JSON.parse(fs.readFileSync(path.join(h.root, 'work/control/notifications.json')));
    assert.equal(saved.channels[0].password, 'private-smtp-password');
    assert.equal(saved.channels[1].token, 'private-bearer');
    assert.ok(saved.channels[1].url.includes('secret-query'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(h.root, 'work/control/notifications.json')).mode & 0o777, 0o600);
});

test('all notification channels validate before configuration is atomically saved', t => {
    const h = harness(t); h.worker.update({ channels: [email()] });
    const file = path.join(h.root, 'work/control/notifications.json'), before = fs.readFileSync(file, 'utf8');
    const cases = [
        null, { offlineDelaySeconds: -1 }, { offlineDelaySeconds: 86401 }, { offlineDelaySeconds: 1.5 },
        { channels: Array.from({ length: 33 }, (_, index) => email({ id: 'mail-' + index })) },
        { channels: [email(), email()] }, { channels: [email({ name: '' })] },
        { channels: [email({ host: 'smtp.test/path' })] }, { channels: [email({ port: 0 })] },
        { channels: [email({ secure: 'false' })] }, { channels: [email({ to: [] })] },
        { channels: [email({ from: 'a@example.test\r\nBcc: victim@example.test' })] },
        { channels: [email({ subjectTemplate: 'subject\nBcc: victim@example.test' })] },
        { channels: [email({ to: ['bad address'] })] },
        { channels: [webhook({ url: 'file:///secret' })] }, { channels: [webhook({ url: 'https://u:p@example.test/path' })] },
        { channels: [webhook({ url: 'https://example.test/path#secret' })] },
        { channels: [webhook({ token: 'token\r\nInjected: true' })] },
        { channels: [email({ id: '../outside' })] }, { unknown: true }
    ];
    for (const value of cases) {
        assert.throws(() => h.worker.update(value), { code: 'INVALID_NOTIFICATION_CONFIG' });
        assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
});

test('secret replacement and explicit clearing are isolated by channel ID and type', t => {
    const h = harness(t); h.worker.update({ channels: [email(), webhook()] });
    let safe = h.worker.config().channels;
    h.worker.update({ channels: [{ ...safe[0], clearPassword: true }, { ...safe[1], clearToken: true }] });
    assert.equal(h.worker.config().channels[0].passwordPresent, false);
    assert.equal(h.worker.config().channels[1].tokenPresent, false);
    safe = h.worker.config().channels;
    h.worker.update({ channels: [{ ...safe[0], password: 'replacement' }, { ...safe[1], token: 'replacement-token' }] });
    assert.equal(h.worker.config().channels[0].passwordPresent, true);
    assert.throws(() => h.worker.update({ channels: [{ ...email(), clearPassword: true }] }), { code: 'INVALID_NOTIFICATION_CONFIG' });
    assert.throws(() => h.worker.update({ channels: [{ ...h.worker.config().channels[1], url: 'https://other.example.test/private' }] }), { code: 'INVALID_NOTIFICATION_CONFIG' });
    h.worker.update({ channels: [{ ...h.worker.config().channels[1], url: 'https://other.example.test/private', clearToken: true }] });
    assert.equal(h.worker.config().channels[0].tokenPresent, false);
    assert.throws(() => h.worker.update({ channels: [{ ...webhook(), id: 'new', url: undefined, token: undefined }] }), { code: 'INVALID_NOTIFICATION_CONFIG' });
});

test('startup is a silent baseline; a sustained outage sends exactly one offline and one recovery', async t => {
    const h = harness(t); h.worker.update({ offlineDelaySeconds: 30, channels: [email()] });
    const a = account(); h.accounts.push(a); h.worker.observe(); await settle(); assert.equal(h.sent.length, 0);
    a.state = 'offline'; a.health.online = false; h.worker.observe();
    h.advance(29999); await settle(); assert.equal(h.sent.length, 0);
    h.advance(1); await settle(); assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].message.subject, 'offline 2068886823 海豚');
    h.worker.observe(); h.advance(60000); await settle(); assert.equal(h.sent.length, 1);
    a.state = 'online'; a.health.online = true; h.worker.observe(); await settle();
    assert.equal(h.sent.length, 2); assert.equal(h.sent[1].message.subject, 'online 2068886823 海豚');
    h.worker.observe(); await settle(); assert.equal(h.sent.length, 2);
});

test('a brief outage and initial offline account never generate a recovery notification', async t => {
    const h = harness(t); h.worker.update({ offlineDelaySeconds: 30, channels: [email()] });
    const a = account(); h.accounts.push(a); h.worker.observe();
    a.state = 'offline'; a.health.online = false; h.worker.observe(); h.advance(2000);
    a.state = 'online'; a.health.online = true; h.worker.observe(); h.advance(60000); await settle();
    assert.equal(h.sent.length, 0); assert.equal(h.timers.size, 0);
    h.accounts.splice(0); h.worker.observe(); a.state = 'offline'; a.health.online = false;
    h.accounts.push(a); h.worker.observe(); h.advance(60000); await settle(); assert.equal(h.sent.length, 0);
    a.state = 'online'; a.health.online = true; h.worker.observe(); await settle(); assert.equal(h.sent.length, 0);
});

test('zero debounce sends immediately and changing delay recalculates a pending outage', async t => {
    const h = harness(t); h.worker.update({ offlineDelaySeconds: 30, channels: [email()] });
    const a = account(); h.accounts.push(a); h.worker.observe();
    a.state = 'offline'; a.health.online = false; h.worker.observe(); h.advance(2000);
    h.worker.update({ offlineDelaySeconds: 0 }); await settle();
    assert.equal(h.sent.length, 1); assert.equal(h.timers.size, 0);
});

test('unknown health is never fabricated into online or offline', async t => {
    const h = harness(t); h.worker.update({ offlineDelaySeconds: 0, channels: [email()] });
    const a = account(); h.accounts.push(a); h.worker.observe();
    a.health = null; h.worker.observe(); await settle(); assert.equal(h.sent.length, 0);
    a.health = { selfId: a.boundUin, authorized: false, ready: true, online: true }; h.worker.observe();
    a.health.authorized = true; a.health.online = null; h.worker.observe(); await settle(); assert.equal(h.sent.length, 0);
    assert.equal(snapshot({ ...a, health: { ...a.health, online: true }, state: 'starting' }).value, null);
});

test('a confirmed process crash uses the prior real identity and survives automatic starting', async t => {
    const h = harness(t); h.worker.update({ offlineDelaySeconds: 3, channels: [email()] });
    const a = account(); h.accounts.push(a); h.worker.observe();
    a.health = null; a.state = 'error'; h.worker.observe(); h.advance(1000);
    a.state = 'starting'; h.worker.observe(); h.advance(2000); await settle();
    // Starting remains unknown until the next real state, so the adapter does not claim
    // a current offline state from process survival. The next confirmed error can notify.
    assert.equal(h.sent.length, 0);
    a.state = 'error'; h.worker.observe(); h.advance(3000); await settle(); assert.equal(h.sent.length, 1);
    assert.ok(h.sent[0].message.subject.includes(a.boundUin));
});

test('manual stop, maintenance, bridge removal and explicit suppression cancel pending outages', async t => {
    for (const suppress of [a => { a.desired = 'stopped'; }, a => { a.maintenance = { operation: 'backup' }; },
        a => { a.bridgeInstalled = false; }, a => { a.notificationSuppressed = true; }, a => { a.state = 'stopping'; }]) {
        const h = harness(t); h.worker.update({ offlineDelaySeconds: 3, channels: [email()] });
        const a = account(); h.accounts.push(a); h.worker.observe(); a.state = 'offline'; a.health.online = false; h.worker.observe();
        suppress(a); h.worker.observe(); h.advance(5000); await settle(); assert.equal(h.sent.length, 0); assert.equal(h.timers.size, 0);
    }
});

test('wrong or duplicate QQ identities and account deletion do not notify another account', async t => {
    const h = harness(t); h.worker.update({ offlineDelaySeconds: 1, channels: [email()] });
    const a = account(), b = account('b', '2441760163'); h.accounts.push(a, b); h.worker.observe();
    a.health.selfId = b.boundUin; a.state = 'account_mismatch'; h.worker.observe();
    b.state = 'duplicate_account'; h.worker.observe(); h.advance(1000); await settle(); assert.equal(h.sent.length, 0);
    h.accounts.splice(0); h.worker.observe(); assert.equal(h.worker.states.size, 0);
});

test('per-account channel selection and disabled channels remain isolated', async t => {
    const h = harness(t); h.worker.update({ offlineDelaySeconds: 0, channels: [email(), email({ id: 'mail-2', enabled: false })] });
    const a = account(), b = account('b', '2441760163'); b.notifications.channelIds = ['mail-2'];
    const c = account('c', '3834835490'); c.notifications.enabled = false;
    h.accounts.push(a, b, c); h.worker.observe();
    for (const item of h.accounts) { item.state = 'offline'; item.health.online = false; } h.worker.observe(); await settle();
    assert.equal(h.sent.length, 1); assert.ok(h.sent[0].message.subject.includes(a.boundUin));
    assert.throws(() => h.worker.test('mail-2'), { code: 'NOTIFICATION_DISABLED' });
});

test('SMTP uses verified TLS, omits authentication for relays and substitutes HTML safely', async t => {
    const h = harness(t); h.worker.update({ offlineDelaySeconds: 0, channels: [email({ id: 'mail.smtp-1', port: 587, secure: false,
        user: '', password: '', bodyTemplate: '  <p>{nickname} / {uin} / {error}</p>' })] });
    const a = account(); a.notifications.channelIds = ['mail.smtp-1']; a.health.nickname = '<script>&"\''; a.error = 'x\r\nBcc: value';
    h.accounts.push(a); h.worker.observe(); a.state = 'offline'; a.health.online = false; h.worker.observe(); await settle();
    assert.equal(h.sent.length, 1);
    const { smtp, message } = h.sent[0];
    assert.equal(smtp.secure, false); assert.equal(smtp.requireTLS, true); assert.equal(smtp.tls.rejectUnauthorized, true);
    assert.equal(smtp.auth, undefined); assert.equal(smtp.disableFileAccess, true); assert.equal(message.disableUrlAccess, true);
    assert.ok(message.html.includes('&lt;script&gt;&amp;&quot;&#39;'));
    assert.equal(message.html.includes('<script>'), false);
    assert.equal(message.html.includes('Bcc:'), false);
    assert.equal(message.text, undefined);
});

test('explicit tests have no invented QQ identity and SMTP partial rejection is a failure', async t => {
    const h = harness(t, { sendMail: async () => ({ accepted: ['one@example.test'], rejected: ['two@example.test'] }) });
    h.worker.update({ channels: [email()] });
    const result = await h.worker.test('mail-1'); assert.equal(result.ok, false); assert.equal(result.code, 'SMTP_REJECTED');
    assert.equal(result.profileId, ''); assert.equal(result.event, 'test');
    assert.throws(() => h.worker.test('missing'), { code: 'NOT_FOUND' });
});

test('webhook POST preserves event values, sets bearer auth and forbids redirects', async t => {
    const calls = []; const h = harness(t, { fetch: async (url, options) => { calls.push({ url, options }); return { ok: true }; } });
    h.worker.update({ offlineDelaySeconds: 0, channels: [webhook()] });
    const a = account(); a.notifications.channelIds = ['hook-1']; h.accounts.push(a); h.worker.observe();
    a.state = 'offline'; a.health.online = false; h.worker.observe(); await settle();
    assert.equal(calls.length, 1); assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.redirect, 'error');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer private-bearer');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.uin, a.boundUin); assert.equal(body.profileId, 'a'); assert.equal(body.event, 'offline');
    assert.equal(body.nickname, '海豚'); assert.equal(body.pid, ''); assert.equal(body.error, '');
    assert.match(body.time, /^\d{4}-\d\d-\d\dT/u);
    assert.equal(JSON.stringify(h.worker.config()).includes('private-bearer'), false);
});

test('local real HTTP webhook rejects redirects and non-2xx without retrying', async t => {
    let hits = 0;
    const server = http.createServer((request, response) => { hits++; request.resume(); response.writeHead(302, { Location: '/destination' }); response.end(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const h = harness(t); h.worker.update({ channels: [webhook({ url: 'http://127.0.0.1:' + server.address().port + '/notify' })] });
    const result = await h.worker.test('hook-1'); assert.equal(result.ok, false); assert.equal(hits, 1);
    server.removeAllListeners('request'); server.on('request', (request, response) => { hits++; request.resume(); response.writeHead(503); response.end(); });
    const failed = await h.worker.test('hook-1'); assert.equal(failed.code, 'WEBHOOK_REJECTED'); assert.equal(hits, 2);
});

test('delivery timeout is bounded and a slow channel cannot block a different channel', async t => {
    const h = harness(t, { timeoutMs: 20, sendMail: async smtp => smtp.host === 'blocked.test' ? new Promise(() => {}) : { rejected: [] } });
    h.worker.update({ channels: [email({ host: 'blocked.test' }), email({ id: 'fast' })] });
    const slow = h.worker.test('mail-1'); const fast = await h.worker.test('fast'); assert.equal(fast.ok, true);
    const timed = await slow; assert.equal(timed.ok, false); assert.equal(timed.code, 'NOTIFICATION_TIMEOUT');
    assert.equal(h.worker.deliveries.filter(item => item.channelId === 'mail-1').length, 1);
});

test('each channel queue is bounded and changing a destination cancels stale queued deliveries', async t => {
    let release; const first = new Promise(resolve => { release = resolve; }); let calls = 0;
    const h = harness(t, { queueLimit: 1, sendMail: async () => { calls++; if (calls === 1) await first; return { rejected: [] }; } });
    h.worker.update({ channels: [email()] });
    const active = h.worker.test('mail-1'), pending = h.worker.test('mail-1'), overflow = await h.worker.test('mail-1');
    assert.equal(overflow.code, 'QUEUE_FULL');
    h.worker.update({ channels: [email({ host: 'replacement.test' })] });
    assert.equal((await pending).code, 'CONFIG_CHANGED'); release(); assert.equal((await active).ok, true);
    assert.equal(calls, 1);
});

test('an unknown interval cancels continuity and requires a fresh full offline delay', async t => {
    const h = harness(t); h.worker.update({ offlineDelaySeconds: 10, channels: [email()] });
    const a = account(); h.accounts.push(a); h.worker.observe();
    a.state = 'offline'; a.health.online = false; h.worker.observe(); h.advance(9000);
    a.health.online = null; h.worker.observe(); h.advance(50000); await settle();
    assert.equal(h.sent.length, 0); assert.equal(h.timers.size, 0);
    a.health.online = false; h.worker.observe(); h.advance(9999); await settle(); assert.equal(h.sent.length, 0);
    h.advance(1); await settle(); assert.equal(h.sent.length, 1);
});

test('queued events cannot cross a QQ session epoch or process generation', async t => {
    for (const change of [a => { a.health.sessionEpoch = 'replacement-session'; },
        a => { a.notificationGeneration = 'replacement-process'; }, a => { a.health = null; }]) {
        let release; const blocked = new Promise(resolve => { release = resolve; }); let calls = 0;
        const h = harness(t, { sendMail: async () => { calls++; if (calls === 1) await blocked; return { rejected: [] }; } });
        h.worker.update({ offlineDelaySeconds: 0, channels: [email()] });
        const active = h.worker.test('mail-1');
        const a = account(); a.notificationGeneration = 'initial-process'; h.accounts.push(a); h.worker.observe();
        a.state = 'offline'; a.health.online = false; h.worker.observe();
        change(a); release(); await active; await settle();
        assert.equal(calls, 1); assert.ok(h.worker.deliveries.some(item => item.event === 'offline' && item.code === 'CONFIG_CHANGED'));
    }
});

test('closing aborts active work, cancels pending work and prevents new notifications', async t => {
    const h = harness(t, { sendMail: async () => new Promise(() => {}) }); h.worker.update({ channels: [email()] });
    const active = h.worker.test('mail-1'), pending = h.worker.test('mail-1'); h.worker.close();
    assert.equal((await active).code, 'CLOSING'); assert.equal((await pending).code, 'CLOSING');
    assert.throws(() => h.worker.test('mail-1'), { code: 'CLOSING' });
    assert.equal(h.worker.states.size, 0);
});

test('delivery diagnostics contain codes only, never remote errors, passwords or URLs', async t => {
    const h = harness(t, { sendMail: async () => { throw new Error('private-smtp-password https://secret.example/private?key=secret'); } });
    h.worker.update({ channels: [email()] }); const result = await h.worker.test('mail-1');
    assert.equal(result.code, 'DELIVERY_FAILED');
    const diagnostic = JSON.stringify(h.worker.config());
    assert.equal(diagnostic.includes('private-smtp-password'), false); assert.equal(diagnostic.includes('secret.example'), false);
    for (let index = 0; index < 110; index++) await h.worker.test('mail-1');
    assert.equal(h.worker.config().deliveries.length, 100);
});
