'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const Fastify = require('fastify');
const { Auth } = require('./auth.cjs');
const { Accounts, memoryAvailable, notificationSelection } = require('./accounts.cjs');
const { Notifications } = require('./notifications.cjs');
const { Backups, MAX_ARCHIVE } = require('./backups.cjs');
const { read, atomic, fail, privateDirectory, equalSecret } = require('./files.cjs');
const { workspacePath } = require('../paths.cjs');
const { acquireLock } = require('../lock.cjs');
const { WebSocketServer } = require('ws');
const { RemoteDesktop } = require('./remote.cjs');
const { LogReader } = require('./logs.cjs');
const { ManagementEvents } = require('./events.cjs');
const { AvatarCache } = require('./avatars.cjs');
const { Storage } = require('./storage.cjs');
const { ManagerLifecycle } = require('./lifecycle.cjs');
const { publicSettings, validateGlobalSettingsPatch } = require('../global-services.cjs');
const { MAX_ACTION_BYTES } = require('../onebot/limits.cjs');
const { runtimeInstance } = require('./runtime-instance.cjs');
const { QQRuntimes } = require('./qq-runtimes.cjs');
const media = require('../qq/media.cjs');

function secureHeaders(reply) {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
}

async function createManager({ root = path.resolve(__dirname, '../..'), accounts: providedAccounts, remote: providedRemote, https, startAccounts = true, notificationOptions = {} } = {}) {
    const directory = privateDirectory(root, 'work/control');
    const releaseOwner = acquireLock(directory);
    let lifecycle;
    try {
    const auth = new Auth(directory);
    const instanceHandshake = runtimeInstance();
    const deferAccounts = process.env.FWD_RUNTIME_DEFER_ACCOUNTS === '1';
    if (deferAccounts && !instanceHandshake) throw fail('INVALID_CONFIG', 'Deferred activation requires a local runtime identity');
    let runtimeActivated = !deferAccounts, activationPromise;
    const settingsFile = path.join(directory, 'settings.json');
    const settings = read(settingsFile, { version: 1, maxAccounts: 2, port: 4090, host: '0.0.0.0' });
    if (settings.version !== 1 || !Number.isInteger(settings.maxAccounts) || settings.maxAccounts < 1 || settings.maxAccounts > 16 ||
        !Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535 || typeof settings.host !== 'string') throw fail('INVALID_CONFIG', 'Invalid management settings');
    const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, requestTimeout: 15000, ...(https ? { https } : {}) });
    const accounts = providedAccounts || new Accounts(root, { maxAccounts: settings.maxAccounts });
    const remote = providedRemote || new RemoteDesktop(root, accounts);
    const qqRuntimes = new QQRuntimes(root, accounts);
    qqRuntimes.recover();
    const backups = new Backups(root, accounts, { runtimes: qqRuntimes });
    const logReader = new LogReader(root, accounts);
    const avatars = new AvatarCache(root, accounts);
    const storage = new Storage(root, accounts, { settings, settingsFile, backups });
    const notificationGenerations = new WeakMap();
    const notificationAccounts = () => accounts.list().map(item => {
        const child = accounts.processes.get(item.id);
        if (child && !notificationGenerations.has(child)) notificationGenerations.set(child, crypto.randomBytes(12).toString('hex'));
        return { ...item, notificationGeneration: child ? notificationGenerations.get(child) : null,
            notificationSuppressed: accounts.closing || accounts.stopping.has(item.id) ||
                accounts.busy.has(item.id) && ['stopping', 'stopped'].includes(item.state) };
    });
    const notifications = new Notifications(root, { ...notificationOptions, getAccounts: notificationAccounts });
    const tunnels = new Set();
    let closed = false, closingPromise;
    const overview = () => { const memory = memoryAvailable(); return ({ version: require('../../package.json').version, maxAccounts: accounts.maxAccounts, accounts: accounts.list(),
        recovery: { restorePending: fs.existsSync(backups.journalFile), code: backups.recoveryError },
        resources: { totalMemory: memory.total, freeMemory: memory.free, load: os.loadavg() }, management: { port: settings.port, tls: Boolean(https), logScan: logReader.lastRead } }); };
    const events = new ManagementEvents({ overview, readLogs: () => logReader.read({ limit: 100 }), auth });
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_ARCHIVE }, (_request, body, done) => done(null, body));
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, body));
    app.addHook('onSend', async (_request, reply, payload) => { secureHeaders(reply); return payload; });
    app.setErrorHandler((error, _request, reply) => {
        const status = error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
        reply.code(status).send({ error: { code: error.code || 'INTERNAL_ERROR', message: status === 500 ? 'Management operation failed' : error.message } });
    });
    // Authenticate before reading potentially large backup or media request bodies.
    app.addHook('onRequest', async request => {
        if (closed) throw fail('CLOSING', 'Management service is stopping', 503);
        if (!request.url.startsWith('/api/')) return;
        const route = request.url.split('?')[0];
        if (instanceHandshake && ['/api/runtime/instance', '/api/runtime/activate'].includes(route)) return;
        if (!runtimeActivated) throw fail('STARTING', 'Local runtime verification is pending', 503);
        if (['/api/auth/state', '/api/auth/bootstrap', '/api/auth/login'].includes(route)) return;
        request.adminSession = auth.require(request, !['GET', 'HEAD'].includes(request.method));
    });
    const ok = data => ({ data });
    if (instanceHandshake) app.get('/api/runtime/instance', async request => instanceHandshake(request));
    if (instanceHandshake) app.post('/api/runtime/activate', async request => {
        const identity = instanceHandshake(request);
        if (!runtimeActivated) {
            // One activation per process. A failed initialization stays blocked;
            // the launcher stops the instance instead of retrying writes.
            activationPromise ||= Promise.resolve().then(async () => {
                if (startAccounts) await accounts.initialize();
                runtimeActivated = true;
            });
            await activationPromise;
        }
        return { ...identity, activated: true };
    });
    app.get('/api/auth/state', async request => {
        const session = auth.session(request.headers.cookie);
        return ok({ initialized: Boolean(auth.record), authenticated: Boolean(session), ...(session ? { csrf: session.csrf } : {}) });
    });
    function checkPublicOrigin(request) {
        if (request.headers.origin && request.headers.origin !== request.protocol + '://' + request.headers.host) throw fail('ORIGIN_REJECTED', 'Cross-origin login rejected', 403);
    }
    app.post('/api/auth/bootstrap', async (request, reply) => {
        checkPublicOrigin(request);
        const session = await auth.bootstrap(request.body?.setupToken, request.body?.password, request.ip);
        reply.header('Set-Cookie', auth.cookie(session.id, request.protocol === 'https'));
        return ok({ csrf: session.csrf });
    });
    app.post('/api/auth/login', async (request, reply) => {
        checkPublicOrigin(request);
        const session = await auth.login(request.body?.password, request.ip);
        reply.header('Set-Cookie', auth.cookie(session.id, request.protocol === 'https'));
        return ok({ csrf: session.csrf });
    });
    app.post('/api/auth/logout', async (request, reply) => {
        auth.revoke(request.adminSession.id); reply.header('Set-Cookie', auth.cookie('', request.protocol === 'https', true)); return ok(true);
    });
    app.post('/api/auth/password', async request => { await auth.change(request.body?.currentPassword, request.body?.newPassword); return ok(true); });
    app.get('/api/overview', async () => ok(overview()));
    app.get('/api/accounts', async () => ok(accounts.list()));
    app.get('/api/qq-runtimes', async () => ok(qqRuntimes.list()));
    app.post('/api/qq-runtimes/import', async request => ok(qqRuntimes.register(request.body)));
    app.post('/api/accounts/:id/runtime', async request => {
        const revision = request.headers['if-match'];
        if (revision !== undefined && (typeof revision !== 'string' || !/^[1-9]\d{0,14}$/.test(revision))) throw fail('INVALID_PARAMS', 'Invalid account configuration revision');
        return ok(await qqRuntimes.switch(request.params.id, request.body, { expectedRevision: revision === undefined ? undefined : Number(revision) }));
    });
    app.get('/api/accounts/:id/avatar', async (request, reply) => {
        const value = await avatars.get(request.params.id);
        return reply.type(value.type).send(value.bytes);
    });
    app.get('/api/accounts/:id/avatars/:kind/:targetId', async (request, reply) => {
        const value = await avatars.getContact(request.params.id, request.params.kind, request.params.targetId);
        return reply.type(value.type).send(value.bytes);
    });
    function validateSelection(value, existing) {
        const selection = notificationSelection(value);
        const known = new Set(notifications.config().channels.map(channel => channel.id));
        for (const id of existing?.notifications?.channelIds || []) known.add(id);
        if (selection.channelIds.some(id => !known.has(id))) throw fail('INVALID_CONFIG', 'Notification channel not found');
        return selection;
    }
    app.post('/api/accounts', async request => {
        if (request.body?.notifications !== undefined) validateSelection(request.body.notifications);
        return ok(accounts.create(request.body));
    });
    app.get('/api/accounts/:id/config', async request => ok(accounts.list().find(item => item.id === accounts.get(request.params.id).id)));
    app.patch('/api/accounts/:id/config', async request => {
        if (request.body?.notifications !== undefined) validateSelection(request.body.notifications, accounts.get(request.params.id));
        return ok(await accounts.update(request.params.id, request.body));
    });
    app.get('/api/accounts/:id/notifications', async request => ok(notificationSelection(accounts.get(request.params.id).notifications)));
    app.patch('/api/accounts/:id/notifications', { bodyLimit: 8192 }, async request =>
        ok(await accounts.updateNotifications(request.params.id, validateSelection(request.body, accounts.get(request.params.id)))));
    app.get('/api/notifications', async () => ok(notifications.config()));
    app.put('/api/notifications', { bodyLimit: 512 * 1024 }, async request => ok(await notifications.update(request.body)));
    const notificationTests = new Set(), lastNotificationTests = new Map();
    app.post('/api/notifications/channels/:id/test', { bodyLimit: 1024 }, async request => {
        const id = request.params.id;
        for (const [channelId, at] of lastNotificationTests) if (Date.now() - at >= 10000) lastNotificationTests.delete(channelId);
        if (notificationTests.has(id) || Date.now() - (lastNotificationTests.get(id) || 0) < 10000) {
            throw fail('RATE_LIMIT', 'Wait 10 seconds before another test notification', 429);
        }
        if (!notifications.config().channels.some(channel => channel.id === id)) throw fail('NOT_FOUND', 'Notification channel not found', 404);
        notificationTests.add(id); lastNotificationTests.set(id, Date.now());
        try {
            const result = await notifications.test(id);
            if (!result.success) throw fail('NOTIFICATION_DELIVERY_FAILED', '通知投递失败：' + result.code, 502);
            return ok(result);
        }
        finally { notificationTests.delete(id); }
    });
    for (const operation of ['start', 'stop', 'restart']) app.post('/api/accounts/:id/' + operation, async request => {
        if (operation !== 'start') await remote.close(request.params.id);
        return ok(await accounts[operation](request.params.id) || true);
    });
    for (const operation of ['install', 'uninstall']) app.post('/api/accounts/:id/' + operation, async request => {
        await remote.close(request.params.id);
        return ok(await accounts[operation](request.params.id));
    });
    app.delete('/api/accounts/:id', async request => {
        accounts.get(request.params.id);
        if (request.body?.confirmId !== request.params.id) throw fail('CONFIRMATION_REQUIRED', 'Enter the exact account instance ID to delete it', 409);
        await remote.close(request.params.id);
        return ok(await accounts.remove(request.params.id, { confirmId: request.body.confirmId }));
    });
    app.get('/api/accounts/:id/remote', async request => { accounts.get(request.params.id); return ok(remote.status(request.params.id)); });
    app.post('/api/accounts/:id/remote/open', async request => ok(await remote.open(request.params.id)));
    app.delete('/api/accounts/:id/remote', async request => { accounts.get(request.params.id); await remote.close(request.params.id); return ok(true); });
    app.post('/api/accounts/:id/maintenance/recover', async request => {
        await accounts.recoverMaintenance(request.params.id);
        backups.ensureRecovered();
        return ok(true);
    });
    app.post('/api/accounts/:id/action', { bodyLimit: MAX_ACTION_BYTES }, async request => {
        if (typeof request.body?.action !== 'string') throw fail('INVALID_PARAMS', 'An action name is required');
        return ok(await accounts.action(request.params.id, request.body.action, request.body.params || {}));
    });
    function mediaCapacity(directory, incoming) {
        let bytes = 0, count = 0;
        for (const name of fs.readdirSync(directory)) {
            const stat = fs.lstatSync(path.join(directory, name));
            if (stat.isFile() && !stat.isSymbolicLink()) { bytes += stat.size; count++; }
        }
        if (bytes + incoming > 256 * 1024 * 1024 || count >= 1000) throw fail('MEDIA_LIMIT', 'Account temporary media limit reached', 409);
    }
    app.post('/api/accounts/:id/media', { bodyLimit: 10 * 1024 * 1024 }, async request => {
        accounts.get(request.params.id);
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 10 * 1024 * 1024) throw fail('INVALID_MEDIA', 'Upload a PNG, JPEG or GIF of at most 10 MiB');
        const ext = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png' :
            bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg' : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) ? 'gif' : null;
        if (!ext) throw fail('INVALID_MEDIA', 'Unsupported image signature');
        const directory = privateDirectory(root, path.join(accounts.location(request.params.id), 'media'));
        mediaCapacity(directory, bytes.length);
        const filename = path.join(directory, crypto.randomBytes(16).toString('hex') + '.' + ext);
        fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
        return ok({ file: filename, size: bytes.length });
    });
    app.post('/api/accounts/:id/files', { bodyLimit: 50 * 1024 * 1024 }, async request => {
        accounts.get(request.params.id);
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 50 * 1024 * 1024) throw fail('INVALID_MEDIA', 'Upload a file of at most 50 MiB');
        let name;
        try { name = decodeURIComponent(request.headers['x-filename'] || 'attachment'); } catch { throw fail('INVALID_MEDIA', 'Invalid filename'); }
        if (!name || name.length > 200 || /[\\/\u0000-\u001f]/.test(name) || name === '.' || name === '..') throw fail('INVALID_MEDIA', 'Invalid filename');
        const directory = privateDirectory(root, path.join(accounts.location(request.params.id), 'media'));
        mediaCapacity(directory, bytes.length);
        const file = path.join(directory, crypto.randomBytes(16).toString('hex') + '.upload');
        fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
        return ok({ file, name, size: bytes.length });
    });
    for (const [suffix, action] of [['friends', 'get_friend_list'], ['groups', 'get_group_list']]) app.get('/api/accounts/:id/' + suffix, async request => {
        const result = await accounts.action(request.params.id, action);
        if (result.status !== 'ok') throw fail('QUERY_FAILED', result.message || 'QQ query failed', 502);
        return ok(result.data);
    });
    app.get('/api/accounts/:id/groups/:groupId/members', async request => {
        const result = await accounts.action(request.params.id, 'get_group_member_list', { group_id: request.params.groupId });
        if (result.status !== 'ok') throw fail('QUERY_FAILED', result.message || 'QQ member query failed', 502);
        return ok(result.data);
    });
    app.get('/api/capabilities', async () => ok(require('../onebot/capabilities.cjs').capabilities({})));
    app.get('/api/accounts/:id/capabilities', async request => {
        const result = await accounts.action(request.params.id, 'get_capabilities');
        if (result.status !== 'ok') throw fail('QUERY_FAILED', result.message || 'Capability query failed', 502);
        return ok(result.data);
    });
    app.get('/api/logs', async (request, reply) => {
        const rows = logReader.read(request.query);
        reply.header('X-Freshwater-Logs-Partial', String(logReader.lastRead.partial));
        return ok(rows);
    });
    app.get('/api/logs/export', async (request, reply) => {
        const rows = logReader.read({ ...request.query, includeContent: false });
        return reply.header('Content-Disposition', 'attachment; filename="freshwater-logs.jsonl"')
            .type('application/x-ndjson; charset=utf-8').send(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    });
    app.get('/api/events', async (request, reply) => {
        events.open(reply.raw, request.adminSession);
        reply.hijack();
    });
    app.get('/api/settings', async () => ok({ ...publicSettings(settings), needsRestart: false }));
    app.patch('/api/settings', async request => {
        const next = validateGlobalSettingsPatch(request.body, settings);
        if (next.maxAccounts < accounts.processes.size) throw fail('INVALID_CONFIG', 'Stop accounts before lowering this limit');
        const needsRestart = next.publicBaseUrl !== settings.publicBaseUrl && accounts.processes.size > 0;
        atomic(settingsFile, next);
        Object.assign(settings, next); accounts.maxAccounts = next.maxAccounts;
        return ok({ ...publicSettings(settings), needsRestart });
    });
    app.get('/api/storage', async () => ok(storage.snapshot()));
    app.patch('/api/storage/policy', { bodyLimit: 4096 }, async request => {
        if (storage.active) throw fail('BUSY', 'Finish the current cleanup before changing its policy', 409);
        const value = storage.updatePolicy(request.body);
        return ok({ ...value, cleanup: await storage.cleanup({ scope: 'logs' }) });
    });
    app.post('/api/storage/cleanup', { bodyLimit: 4096 }, async request => ok(await storage.cleanup(request.body)));
    app.get('/api/backups', async () => ok(backups.list()));
    app.post('/api/backups', { bodyLimit: 8192 }, async request => ok(await backups.create(request.body)));
    app.post('/api/backups/upload', { bodyLimit: MAX_ARCHIVE }, async request => ok(backups.upload(request.body)));
    app.delete('/api/backups/:id', async request => ok(backups.remove(request.params.id)));
    app.get('/api/backups/:id/download', async (request, reply) => {
        const file = backups.file(request.params.id);
        return reply.header('Content-Disposition', 'attachment; filename="' + path.basename(file) + '"').type('application/octet-stream').send(backups.download(request.params.id));
    });
    app.post('/api/backups/restore/preview', async request => ok(await backups.preview(request.body)));
    app.post('/api/backups/restore/apply', async request => {
        if (typeof request.body?.backupId !== 'string' || typeof request.body?.previewId !== 'string') throw fail('INVALID_PARAMS', 'Choose the backup and its validated preview');
        return ok(await backups.apply(request.body.previewId, request.body.backupId));
    });

    app.get('/media/:profileId/:opaque', async (request, reply) => {
        const { profileId, opaque } = request.params;
        accounts.get(profileId);
        if (!media.RESOURCE.test(opaque)) throw fail('NOT_FOUND', 'Media not found', 404);
        const expires = request.query.expires, now = Math.floor(Date.now() / 1000);
        if (typeof expires !== 'string' || !/^\d{10}$/.test(expires) || Number(expires) < now || Number(expires) > now + 300) throw fail('MEDIA_EXPIRED', 'Image link expired', 403);
        const base = accounts.location(profileId), key = fs.readFileSync(workspacePath(root, path.join(base, 'state/media-key.txt')), 'utf8').trim();
        if (!/^[a-f0-9]{64}$/i.test(key)) throw fail('MEDIA_KEY', 'Image signing key unavailable', 503);
        const expected = crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(profileId + '\n' + opaque + '\n' + expires).digest('hex');
        if (!equalSecret(request.query.signature || '', expected)) throw fail('MEDIA_SIGNATURE', 'Invalid image signature', 403);
        let info;
        try { info = media.resourceInfo(workspacePath(root, path.join(base, 'media')), opaque); }
        catch { throw fail('NOT_FOUND', 'Media not found', 404); }
        return reply.header('Content-Length', info.size).type(info.mime).send(fs.createReadStream(info.path));
    });

    app.all('/onebot/:profileId/:nodeId', { bodyLimit: MAX_ACTION_BYTES }, proxy);
    app.all('/onebot/:profileId/:nodeId/*', { bodyLimit: MAX_ACTION_BYTES }, proxy);
    async function proxy(request, reply) {
        const id = request.params.profileId, item = accounts.get(id);
        if (!item.nodes.some(node => node.id === request.params.nodeId && node.enabled && node.type === 'httpApi')) throw fail('NOT_FOUND', 'Node not found', 404);
        const actionPath = request.params['*'] || '';
        if (actionPath && (!/^[A-Za-z0-9_.-]+$/.test(actionPath) || ['.', '..'].includes(actionPath))) throw fail('NOT_FOUND', 'Invalid action path', 404);
        // Build the upstream path from validated route components. Never proxy client-controlled dot segments or absolute URLs.
        const query = new URL(request.raw.url, 'http://localhost').search;
        const upstreamPath = '/onebot/' + encodeURIComponent(id) + '/' + encodeURIComponent(request.params.nodeId) + (actionPath ? '/' + actionPath : '') + query;
        const port = accounts.gateway(id);
        const headers = { ...request.headers, host: '127.0.0.1:' + port };
        delete headers.cookie; delete headers['content-length']; delete headers['transfer-encoding'];
        const body = request.body === undefined ? undefined : typeof request.body === 'string' || Buffer.isBuffer(request.body) ? request.body : JSON.stringify(request.body);
        if (body !== undefined) headers['content-length'] = Buffer.byteLength(body);
        return new Promise((resolve, reject) => {
            const upstream = http.request({ host: '127.0.0.1', port, path: upstreamPath, method: request.method, headers, timeout: Math.max(item.actionTimeoutMs, 60000) + 1000 }, response => {
                reply.hijack(); reply.raw.writeHead(response.statusCode, { 'Content-Type': response.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                response.pipe(reply.raw); response.on('end', resolve); response.on('error', () => { reply.raw.destroy(); resolve(); });
            });
            upstream.on('timeout', () => upstream.destroy(fail('TIMEOUT', 'Account gateway timeout', 504)));
            upstream.on('error', reject);
            request.raw.on('aborted', () => upstream.destroy());
            if (body !== undefined) upstream.write(body); upstream.end();
        });
    }
    const remoteWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false,
        handleProtocols: protocols => protocols.has('binary') ? 'binary' : false });
    function upgradeRemote(request, socket, head, url, id) {
        let session, record;
        try {
            session = auth.session(request.headers.cookie);
            if (!session) throw fail('AUTH_REQUIRED', 'Administrator login required', 401);
            const expectedOrigin = (request.socket.encrypted ? 'https' : 'http') + '://' + request.headers.host;
            if (request.headers.origin !== expectedOrigin) throw fail('ORIGIN_REJECTED', 'Same-origin remote login required', 403);
            if (url.searchParams.getAll('session').length !== 1) throw fail('INVALID_REQUEST', 'Invalid remote session', 400);
            record = remote.get(id, url.searchParams.get('session'));
        } catch (error) {
            socket.end('HTTP/1.1 ' + (error.statusCode || 404) + ' Rejected\r\nConnection: close\r\n\r\n'); return;
        }
        try { remoteWss.handleUpgrade(request, socket, head, ws => {
            const upstream = net.connect(record.port, '127.0.0.1');
            record.connections.add(ws); record.connections.add(upstream);
            const sessionStream = { end() { ws.terminate(); upstream.destroy(); } };
            session.streams.add(sessionStream);
            const watchdog = setInterval(() => {
                try { if (auth.session(request.headers.cookie) !== session) throw new Error('Session expired'); remote.get(id, record.sessionId); }
                catch { sessionStream.end(); }
            }, 1000);
            watchdog.unref();
            const cleanup = () => { clearInterval(watchdog); session.streams.delete(sessionStream);
                record.connections.delete(ws); record.connections.delete(upstream); upstream.destroy(); };
            ws.on('message', (data, binary) => {
                if (!binary) { ws.close(1003, 'Binary RFB required'); return; }
                if (!upstream.write(data)) ws.pause();
            });
            upstream.on('drain', () => ws.resume());
            upstream.on('data', data => {
                upstream.pause();
                if (ws.readyState !== ws.OPEN) { upstream.destroy(); return; }
                ws.send(data, { binary: true }, error => { if (error) upstream.destroy(); else upstream.resume(); });
            });
            ws.once('close', cleanup);
            ws.on('error', () => upstream.destroy());
            upstream.on('error', () => ws.terminate()); upstream.once('close', () => ws.terminate());
        }); } catch { socket.destroy(); }
    }
    app.server.on('upgrade', (request, socket, head) => {
        if (closed) { socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n'); return; }
        let url;
        try { url = new URL(request.url, 'http://localhost'); } catch { socket.destroy(); return; }
        const remoteRoute = url.pathname.match(/^\/api\/accounts\/([A-Za-z0-9_-]+)\/remote\/socket$/);
        if (remoteRoute) { upgradeRemote(request, socket, head, url, remoteRoute[1]); return; }
        let port;
        try {
            const route = new URL(request.url, 'http://localhost').pathname.match(/^\/onebot\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(?:\/(?:api|event))?\/?$/);
            if (!route) throw new Error('unknown route');
            const item = accounts.get(route[1]);
            if (!item.nodes.some(node => node.id === route[2] && node.enabled && node.type === 'wsServer')) throw new Error('unknown node');
            port = accounts.gateway(route[1]);
        } catch { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
        const upstream = net.connect(port, '127.0.0.1');
        tunnels.add(socket); socket.once('close', () => { tunnels.delete(socket); upstream.destroy(); });
        upstream.once('connect', () => {
            let header = request.method + ' ' + request.url + ' HTTP/1.1\r\n';
            for (const [key, value] of Object.entries(request.headers)) if (key !== 'cookie') header += key + ': ' + (Array.isArray(value) ? value.join(', ') : value) + '\r\n';
            upstream.write(header + '\r\n'); if (head.length) upstream.write(head);
            socket.pipe(upstream); upstream.pipe(socket);
        });
        upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    });
    app.get('/*', async (request, reply) => {
        if (request.url.startsWith('/api/') || request.url.startsWith('/onebot/')) throw fail('NOT_FOUND', 'Route not found', 404);
        const base = path.join(root, 'webui/dist');
        let file;
        try {
            const requested = decodeURIComponent(request.url.split('?')[0]);
            if (requested.includes('\\') || requested.split('/').includes('..')) throw new Error('Invalid path');
            file = workspacePath(root, path.join('webui/dist', requested));
            if (fs.existsSync(file) && !fs.realpathSync(file).startsWith(fs.realpathSync(base) + path.sep) && fs.realpathSync(file) !== fs.realpathSync(base)) throw new Error('Invalid path');
        }
        catch { throw fail('NOT_FOUND', 'File not found', 404); }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(base, 'index.html');
        if (!fs.existsSync(file)) return reply.type('text/plain').code(503).send('WebUI build missing. Build webui before starting the management server.');
        const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon' }[path.extname(file)] || 'application/octet-stream';
        return reply.type(type).send(fs.createReadStream(file));
    });
    lifecycle = await new ManagerLifecycle(root, accounts).open();
    if (startAccounts && !deferAccounts) await accounts.initialize();
    storage.start();
    const previousAccountChange = accounts.onChange;
    const observeNotifications = () => { if (!closed) notifications.observe(notificationAccounts()); };
    accounts.onChange = (...args) => { try { previousAccountChange(...args); } finally { observeNotifications(); } };
    observeNotifications();
    const notificationTimer = setInterval(observeNotifications, 500);
    notificationTimer.unref();
    function close() {
        if (closingPromise) return closingPromise;
        closed = true;
        closingPromise = (async () => { try {
            const errors = [];
            const clean = async operation => { try { await operation(); } catch (error) { errors.push(error); } };
            clearInterval(notificationTimer); accounts.onChange = previousAccountChange;
            await clean(() => lifecycle.close());
            await clean(() => notifications.close());
            await clean(() => events.close()); await clean(() => auth.close());
            await clean(() => logReader.close()); await clean(() => avatars.close()); await clean(() => storage.close());
            await clean(() => backups.close());
            for (const socket of tunnels) await clean(() => socket.destroy());
            await clean(() => remote.closeAll());
            for (const ws of remoteWss.clients) await clean(() => ws.terminate());
            await clean(() => remoteWss.close());
            await clean(() => accounts.close());
            await clean(() => app.close());
            if (errors.length) throw new AggregateError(errors, 'Management service cleanup failed');
        }
        finally { releaseOwner(); } })();
        return closingPromise;
    }
    return { app, auth, accounts, remote, backups, qqRuntimes, storage, settings, notifications, lifecycle, overview, close };
    } catch (error) { try { await lifecycle?.close(); } finally { releaseOwner(); } throw error; }
}
module.exports = { createManager };
