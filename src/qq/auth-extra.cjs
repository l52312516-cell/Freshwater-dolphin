'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { uint } = require('./admin-oidb.cjs');
const { createGroupWeb } = require('./group-web.cjs');
const { createWeb } = require('./qzone-web.cjs');
const db = require('./db-key-protocol.cjs');
const OPERATIONS = Object.freeze({ 'auth.clientKey': [], 'auth.cookies': ['domain'], 'auth.csrf': [], 'auth.credentials': ['domain'], 'auth.decryptKey': ['dbPath'] });
const DOMAINS = Object.freeze(['qun.qq.com', 'web.qun.qq.com', 'qzone.qq.com', 'vip.qq.com']);
const credential = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x3a\x3c-\x7e]+$/.test(value);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function domain(value = 'qun.qq.com') { if (value === '') value = 'qun.qq.com'; if (!DOMAINS.includes(value)) fail('INVALID_PARAMS', 'Unsupported fixed QQ credential domain'); return value; }
function csrf(value) {
    if (!credential(value)) fail('INVALID_RESPONSE', 'QQ supplied no valid CSRF source');
    let hash = 5381; for (let i = 0; i < value.length; i++) hash = (Math.imul(hash, 33) + value.charCodeAt(i)) | 0;
    return hash & 0x7fffffff;
}
function databaseSalt(filename, roots) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0') || Buffer.byteLength(filename) > 4096 || !/\.db$/i.test(filename)) fail('INVALID_PARAMS', 'Use an absolute database path inside this managed account');
    const target = path.resolve(filename);
    const root = roots.find(value => { const relative = path.relative(value, target); return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); });
    if (!root) fail('INVALID_PARAMS', 'Database path is outside this managed account');
    let current = root;
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root) fail('INVALID_PARAMS', 'Managed database root is not an ordinary directory');
    for (const part of path.relative(root, target).split(path.sep)) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) fail('INVALID_PARAMS', 'Database paths cannot contain symbolic links'); }
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const info = fs.fstatSync(fd); if (!info.isFile() || info.size < 0xaf || info.nlink !== 1) fail('INVALID_PARAMS', 'Database header is not an ordinary private file');
        if (process.platform === 'linux' && fs.realpathSync('/proc/self/fd/' + fd) !== target || fs.realpathSync(target) !== target) fail('INVALID_PARAMS', 'Database file resolved outside its checked account path');
        const header = Buffer.alloc(0xaf); if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) fail('INVALID_RESPONSE', 'Database header could not be read completely');
        return db.salt(header.subarray(0x2f, 0xaf).toString('latin1'));
    } finally { fs.closeSync(fd); }
}
function createAuthExtra(capture, { fetchImpl = globalThis.fetch, native = require('./msf-native.cjs'), databaseRoots = [] } = {}) {
    if (!Array.isArray(databaseRoots) || databaseRoots.some(value => typeof value !== 'string' || !path.isAbsolute(value))) fail('INVALID_CONFIG', 'Database roots must be trusted absolute account directories');
    const roots = [...new Set(databaseRoots.map(value => path.resolve(value)))], group = createGroupWeb(capture, { fetchImpl });
    const qzone = createWeb(capture, fetchImpl), vip = createWeb(capture, fetchImpl, 'friendDress');
    const pending = new Set(); let generation = 0;
    function capabilities() {
        const ticket = capture.hasMethods('ticket', ['forceFetchClientKey']), web = ticket && typeof fetchImpl === 'function';
        return { authClientKey: ticket, authCookies: web, authCsrf: web, authCredentials: web, databaseKey: roots.length > 0 && native.available() };
    }
    async function query(data, context = {}) {
        const allowed = OPERATIONS[data?.operation]; if (!allowed) fail('UNSUPPORTED', 'Unknown fixed QQ authentication query');
        db.fields(data, ['operation', 'expectedEpoch', ...allowed]);
        const selectedDomain = ['auth.cookies', 'auth.credentials'].includes(data.operation) ? domain(data.domain) : 'qun.qq.com';
        if (context.expiresAt !== undefined && !Number.isFinite(context.expiresAt)) fail('INVALID_PARAMS', 'Invalid authentication deadline');
        capture.ensureReady();
        if (data.expectedEpoch !== capture.epoch) fail('SESSION_CHANGED', 'Authentication query must bind the current QQ session');
        const saved = { epoch: capture.epoch, session: capture.session, uin: uint(capture.self?.uin, 'account', 0xffffffffn, 1n), uid: capture.self?.uid, generation };
        if (typeof saved.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(saved.uid)) fail('NOT_READY', 'Authentication query requires a complete QQ account identity');
        const bounded = { ...context, expiresAt: Math.min(Date.now() + 15000, context.expiresAt ?? Infinity) };
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || String(capture.self?.uin) !== saved.uin || capture.self?.uid !== saved.uid || generation !== saved.generation) fail('SESSION_CHANGED', 'QQ changed during the authentication query');
            if (bounded.signal?.aborted || Date.now() >= bounded.expiresAt) fail('EXPIRED', 'Authentication query expired');
        };
        active();
        const capability = { 'auth.clientKey': 'authClientKey', 'auth.cookies': 'authCookies', 'auth.csrf': 'authCsrf', 'auth.credentials': 'authCredentials', 'auth.decryptKey': 'databaseKey' }[data.operation];
        if (!capabilities()[capability]) fail('UNSUPPORTED', 'QQ lacks the required fixed authentication service');
        if (pending.size >= 4) fail('BUSY', 'Authentication queries await physical completion');
        const token = {}; pending.add(token);
        const task = Promise.resolve().then(async () => {
            active(); let result;
            if (data.operation === 'auth.clientKey') {
                const value = await capture.invoke('ticket', 'forceFetchClientKey', ['']); active();
                if (value?.result !== 0 || !credential(value.clientKey)) fail('INVALID_RESPONSE', 'QQ supplied no valid client ticket');
                try { result = { clientKey: value.clientKey, expireTime: uint(value.expireTime, 'ticket expiry', 0xffffffffffffffffn, 1n), keyIndex: uint(value.keyIndex, 'ticket index') }; }
                catch { fail('INVALID_RESPONSE', 'QQ supplied no exact client ticket metadata'); }
            } else if (data.operation === 'auth.decryptKey') {
                const salt = databaseSalt(data.dbPath, roots); active();
                const value = await native.run(capture, { op: 'fixedDbKey', operation: 'db.key', request: { salt }, expectedEpoch: saved.epoch, expectedUin: saved.uin, signal: bounded.signal,
                    timeoutMs: Math.max(1, Math.min(10000, bounded.expiresAt - Date.now())) }); active();
                if (!credential(value?.key)) fail('INVALID_RESPONSE', 'QQ supplied no valid database key'); result = { db_key: value.key };
            } else {
                let cookies, tokenValue, skeyToken;
                if (['qun.qq.com', 'web.qun.qq.com'].includes(selectedDomain)) {
                    const auth = await group.authenticate(selectedDomain, bounded, saved); active(); cookies = auth.cookie; tokenValue = Number(auth.urlKey); skeyToken = Number(auth.bodyKey);
                } else {
                    const auth = await (selectedDomain === 'vip.qq.com' ? vip : qzone).authenticate({ saved, context: bounded, active }); active();
                    cookies = auth.domainCookie(); tokenValue = Number(auth.key); skeyToken = csrf(auth.skey);
                }
                if (typeof cookies !== 'string' || !cookies || Buffer.byteLength(cookies) > 65536 || /[\r\n\0]/.test(cookies) || ![tokenValue, skeyToken].every(value => Number.isInteger(value) && value >= 0 && value <= 0x7fffffff)) fail('INVALID_RESPONSE', 'QQ supplied no valid domain credentials');
                result = data.operation === 'auth.csrf' ? { token: skeyToken } : data.operation === 'auth.cookies' ? { cookies } : { cookies, token: tokenValue, csrf_token: tokenValue };
            }
            active(); return { operation: data.operation, uin: saved.uin, result };
        }).catch(error => { const code = ['INVALID_PARAMS', 'INVALID_RESPONSE', 'SESSION_CHANGED', 'EXPIRED', 'TIMEOUT', 'AUTH_FAILED', 'UNSUPPORTED', 'KERNEL_ERROR'].includes(error?.code) ? error.code : 'QUERY_FAILED'; fail(code, 'QQ authentication query did not complete'); });
        task.then(() => pending.delete(token), () => pending.delete(token));
        const result = await capture.deadline(() => task, bounded, 15000); active(); return result;
    }
    return { capabilities, query, clear() { generation++; } };
}
module.exports = { createAuthExtra, OPERATIONS, DOMAINS, domain, csrf, credential, databaseSalt };
