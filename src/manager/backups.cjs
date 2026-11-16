'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { atomic, read, fail, privateDirectory, identifier, expectedUin, durableRename, syncDirectory } = require('./files.cjs');
const { workspacePath } = require('../paths.cjs');
const { profile } = require('./accounts.cjs');
const { memoryAvailable } = require('./resources.cjs');
const derive = promisify(crypto.scrypt);
const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);
const MAX = 128 * 1024 * 1024;
const MAX_ARCHIVE = 192 * 1024 * 1024;
const MAGIC = Buffer.from('FWDBACK2\n');
const ROOTS = new Set(['home', 'config', 'data']);
const OMIT = /(?:^|\/)(?:[^/]*cache[^/]*|logs?|Crashpad|Singleton\w*|\.lock|Emoji|PokeFace|Skin|dynamic_module)(?:\/|$)/i;

function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function safeName(value) {
    if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || /[\u0000-\u001f]/.test(value) ||
        value.split('/').some(part => !part || part === '.' || part === '..') || !ROOTS.has(value.split('/')[0])) {
        throw fail('INVALID_BACKUP', 'Unsafe archive path');
    }
    return value;
}
function ordinaryMapping(bytes, account, { strip = false } = {}) {
    let saved;
    try { saved = JSON.parse(bytes.toString('utf8')); } catch (_) { throw fail('INVALID_BACKUP', 'Message mapping is not valid JSON'); }
    if (!saved || saved.version !== 1 || saved.account !== account || !/^[1-9]\d{0,15}$/.test(account) || !Number.isSafeInteger(Number(account)) ||
        !Number.isInteger(saved.nextId) || saved.nextId < 1 || saved.nextId > 0x80000000 || !Array.isArray(saved.entries)) {
        throw fail('INVALID_BACKUP', 'Invalid account message mapping');
    }
    const ids = new Set(), locators = new Set();
    const entries = saved.entries.map(entry => {
        const where = entry?.locator, peer = where?.peer;
        if (!Number.isInteger(entry?.id) || entry.id < 1 || entry.id >= saved.nextId || ids.has(entry.id) || !where || !peer ||
            ![1, 2].includes(peer.chatType) || typeof peer.peerUid !== 'string' || peer.peerUid.length > 128 ||
            !(peer.chatType === 1 ? /^u_[A-Za-z0-9_-]+$/ : /^[1-9]\d{0,15}$/).test(peer.peerUid) ||
            typeof where.nativeId !== 'string' || !/^[0-9]{1,64}$/.test(where.nativeId)) throw fail('INVALID_BACKUP', 'Invalid message locator');
        const identity = JSON.stringify([peer.chatType, peer.peerUid, where.nativeId]);
        if (locators.has(identity)) throw fail('INVALID_BACKUP', 'Duplicate message locator');
        ids.add(entry.id); locators.add(identity);
        const locator = { peer: { chatType: peer.chatType, peerUid: peer.peerUid }, nativeId: where.nativeId };
        for (const key of ['seq', 'clientSeq', 'senderUin']) {
            const value = where[key] === undefined ? '' : where[key];
            if (typeof value !== 'string' || (value !== '' && !/^[0-9]{1,64}$/.test(value))) throw fail('INVALID_BACKUP', 'Invalid message sequence metadata');
            locator[key] = value;
        }
        // Keep the author/time tuple needed to distinguish private client
        // sequences after cached bodies are removed. Older mappings may omit it.
        if (where.senderUid !== undefined) {
            if (typeof where.senderUid !== 'string' || where.senderUid.length > 128 ||
                (where.senderUid !== '' && !/^u_[A-Za-z0-9_-]+$/.test(where.senderUid))) {
                throw fail('INVALID_BACKUP', 'Invalid message author metadata');
            }
            locator.senderUid = where.senderUid;
        }
        if (where.time !== undefined) {
            if (typeof where.time !== 'string' || (where.time !== '' &&
                (!/^[1-9]\d{0,15}$/.test(where.time) || !Number.isSafeInteger(Number(where.time))))) {
                throw fail('INVALID_BACKUP', 'Invalid message time metadata');
            }
            locator.time = where.time;
        }
        const result = { id: entry.id, locator };
        for (const key of ['emitted', 'recalled', 'recallEmitted']) {
            if (entry[key] !== undefined) {
                if (typeof entry[key] !== 'boolean') throw fail('INVALID_BACKUP', 'Invalid message mapping flag');
                result[key] = entry[key];
            }
        }
        return result;
    });
    const result = { version: 1, account, nextId: saved.nextId, entries };
    // Imported ordinary archives must already be stripped; reject hidden records and arbitrary fields.
    if (!strip && JSON.stringify(saved) !== JSON.stringify(result)) {
        const normalized = JSON.parse(JSON.stringify(result));
        function sameKeys(a, b) {
            if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return a === b;
            const left = Object.keys(a).sort(), right = Object.keys(b).sort();
            return JSON.stringify(left) === JSON.stringify(right) && left.every(key => sameKeys(a[key], b[key]));
        }
        if (!sameKeys(saved, normalized)) throw fail('INVALID_BACKUP', 'Ordinary backup contains message content or unknown fields');
    }
    return Buffer.from(JSON.stringify(result));
}
function gather(directory, kind, { sizeOnly = false } = {}) {
    const entries = []; let size = 0;
    function visit(relative) {
        safeName(relative);
        if (OMIT.test(relative)) return;
        const target = path.join(directory, ...relative.split('/'));
        const info = fs.lstatSync(target);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw fail('UNSAFE_FILE', 'Backup cannot contain links or special files');
        if (info.isDirectory()) {
            for (const name of fs.readdirSync(target).sort()) visit(relative + '/' + name);
        } else {
            // Ordinary backups contain only the message-ID store, not QQ login/configuration files.
            if (kind === 'ordinary' && !(sizeOnly ? /^data\/[1-9]\d*\.json(?:\.wal)?$/ : /^data\/[1-9]\d*\.json$/).test(relative)) return;
            size += info.size;
            if (size > MAX || entries.length >= 20000 || info.size > 32 * 1024 * 1024) throw fail('BACKUP_LIMIT', 'Backup exceeds state archive limits');
            if (sizeOnly) { entries.push({ size: info.size }); return; }
            let bytes = fs.readFileSync(target);
            if (kind === 'ordinary') bytes = ordinaryMapping(bytes, path.basename(relative, '.json'), { strip: true });
            entries.push({ name: relative, sha256: hash(bytes), size: bytes.length, data: bytes.toString('base64') });
        }
    }
    for (const name of ROOTS) if (fs.existsSync(path.join(directory, name))) visit(name);
    return entries;
}
function normalizeProfile(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        config.desired !== undefined && !['running', 'stopped'].includes(config.desired) ||
        config.revision !== undefined && (!Number.isSafeInteger(config.revision) || config.revision < 0)) {
        throw fail('INVALID_BACKUP', 'Invalid stored account configuration');
    }
    const normalized = profile({}, { ...config, boundUin: expectedUin(config.boundUin) });
    normalized.revision = config.revision || 0;
    return normalized;
}
function validateArchive(document) {
    if (!document || document.version !== 2 || document.qqVersion !== '3.2.35-54395' || document.architecture !== 'x64' ||
        !['ordinary', 'full'].includes(document.kind) || !Array.isArray(document.profiles) || !document.profiles.length || document.profiles.length > 32) {
        throw fail('INVALID_BACKUP', 'Unsupported backup format or QQ version');
    }
    const ids = new Set(); let total = 0, count = 0;
    for (const item of document.profiles) {
        identifier(item.config?.id);
        if (ids.has(item.config.id) || !Array.isArray(item.entries)) throw fail('INVALID_BACKUP', 'Duplicate or invalid account');
        ids.add(item.config.id); item.config = normalizeProfile(item.config);
        if (document.kind === 'ordinary') for (const node of item.config.nodes) { delete node.token; delete node.secret; }
        const names = new Set();
        for (const entry of item.entries) {
            safeName(entry.name);
            const key = entry.name.toLowerCase();
            if (names.has(key) || typeof entry.data !== 'string' || entry.data.length > 48 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data)) {
                throw fail('INVALID_BACKUP', 'Duplicate archive path or invalid data');
            }
            if (document.kind === 'ordinary' && !/^data\/[1-9]\d*\.json$/.test(entry.name)) throw fail('INVALID_BACKUP', 'Ordinary backup contains private QQ state');
            names.add(key);
            const bytes = Buffer.from(entry.data, 'base64');
            if (bytes.toString('base64') !== entry.data) throw fail('INVALID_BACKUP', 'Invalid base64 encoding');
            if (document.kind === 'ordinary') ordinaryMapping(bytes, path.basename(entry.name, '.json'));
            total += bytes.length; count++;
            if (total > MAX || count > 20000 || bytes.length > 32 * 1024 * 1024 || entry.size !== bytes.length || hash(bytes) !== entry.sha256) {
                throw fail('INVALID_BACKUP', 'Invalid file digest or archive limit exceeded');
            }
        }
        for (const name of names) {
            const pieces = name.split('/'); pieces.pop();
            while (pieces.length) {
                if (names.has(pieces.join('/'))) throw fail('INVALID_BACKUP', 'Conflicting archive paths');
                pieces.pop();
            }
        }
    }
    return document;
}

async function encode(document, password) {
    if (document.kind !== 'ordinary' && (typeof password !== 'string' || password.length < 12 || password.length > 1024)) throw fail('INVALID_PASSWORD', 'Backup password requires 12 to 1024 characters');
    const raw = Buffer.from(JSON.stringify(document)); let plain;
    try { plain = await gzip(raw); } finally { raw.fill(0); }
    if (plain.length > MAX_ARCHIVE) { plain.fill(0); throw fail('BACKUP_LIMIT', 'Archive is too large'); }
    if (document.kind === 'ordinary') return Buffer.concat([MAGIC, Buffer.from([0]), plain]);
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    let key;
    try {
        key = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(MAGIC);
        const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
        return Buffer.concat([MAGIC, Buffer.from([1]), salt, iv, cipher.getAuthTag(), encrypted]);
    } finally { key?.fill(0); plain.fill(0); }
}
async function decode(bytes, password, { maxOutputLength = MAX_ARCHIVE } = {}) {
    if (bytes.length > MAX_ARCHIVE || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw fail('INVALID_BACKUP', 'Invalid backup file');
    const type = bytes[MAGIC.length]; let compressed;
    if (type === 0) compressed = bytes.subarray(MAGIC.length + 1);
    else if (type === 1) {
        if (bytes.length < MAGIC.length + 46 || typeof password !== 'string' || password.length > 1024) throw fail('INVALID_PASSWORD', 'Backup password required');
        let offset = MAGIC.length + 1;
        const salt = bytes.subarray(offset, offset += 16), iv = bytes.subarray(offset, offset += 12), tag = bytes.subarray(offset, offset += 16);
        const key = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(MAGIC); decipher.setAuthTag(tag);
            // Authenticate before parsing or extracting anything.
            compressed = Buffer.concat([decipher.update(bytes.subarray(offset)), decipher.final()]);
        } catch { throw fail('INVALID_PASSWORD', 'Incorrect password or damaged encrypted backup'); }
        finally { key.fill(0); }
    } else throw fail('INVALID_BACKUP', 'Unknown backup encryption format');
    let raw;
    try {
        try { raw = await gunzip(compressed, { maxOutputLength }); }
        catch { throw fail('INVALID_BACKUP', 'Invalid or excessive compressed archive'); }
        const document = validateArchive(JSON.parse(raw.toString('utf8')));
        if ((type === 1) !== (document.kind === 'full')) throw fail('INVALID_BACKUP', 'Backup encryption does not match its kind');
        return document;
    } finally { raw?.fill(0); if (type === 1) compressed.fill(0); }
}

class Backups {
    constructor(root, accounts, { checkpoint = () => {}, previewMs = 300000, now = Date.now, memory = memoryAvailable } = {}) {
        this.root = root; this.accounts = accounts;
        this.directory = privateDirectory(root, 'work/backups');
        this.journalFile = path.join(privateDirectory(root, 'work/control'), 'restore-journal.json');
        this.checkpoint = checkpoint;
        this.memory = memory;
        this.previewMs = previewMs; this.now = now; this.previewTimer = null;
        this.previews = new Map(); this.downloads = new Map(); this.locked = false;
        this.downloadStreams = new Set();
        this.pending = new Set(); this.closed = false; this.closingPromise = null;
        this.recoveryError = null;
        try { this.recover(); } catch (error) { this.recoveryError = error.code || 'RESTORE_RECOVERY_FAILED'; }
    }
    ensureRecovered() {
        if (fs.existsSync(this.journalFile)) this.recover();
        this.recoveryError = null;
    }
    clearPreviews() {
        clearTimeout(this.previewTimer); this.previewTimer = null; this.previews.clear();
    }
    admit(bytes = 0) {
        const free = this.memory().free;
        const reserve = 128 * 1024 * 1024;
        if (!Number.isFinite(free) || free < reserve + Math.max(64 * 1024 * 1024, bytes * 8)) {
            throw fail('LOW_MEMORY', 'Insufficient memory for a consistent backup; stop unused accounts or reduce its size', 503);
        }
        return Math.max(1, Math.min(MAX_ARCHIVE, Math.floor((free - reserve) / 6)));
    }
    assertOpen() { if (this.closed) throw fail('CLOSING', 'Backup service is stopping', 503); }
    track(operation) {
        try {
            this.assertOpen();
            // Run through the first await immediately: the operation's lock
            // must already be owned when a second request is admitted.
            const pending = Promise.resolve(operation()); this.pending.add(pending);
            pending.finally(() => this.pending.delete(pending)).catch(() => {});
            return pending;
        } catch (error) { return Promise.reject(error); }
    }
    journalPaths(journal, swap) {
        const stage = workspacePath(this.root, journal.stage);
        return { current: workspacePath(this.root, path.join('work/accounts', swap.id, swap.name)),
            old: workspacePath(this.root, path.join(journal.stage, swap.id, 'old-' + swap.name)),
            replacement: workspacePath(this.root, path.join(journal.stage, swap.id, swap.name)), stage };
    }
    validateJournal(journal) {
        if (!journal || journal.version !== 1 || !['staging', 'swapping', 'rolling_back', 'rolled_back', 'committed'].includes(journal.phase) ||
            !/^work\/temp\/restore-[a-f0-9]{32}$/.test(journal.stage) || !Array.isArray(journal.ids) || !journal.ids.length ||
            new Set(journal.ids).size !== journal.ids.length || !Array.isArray(journal.swaps) || !Array.isArray(journal.previous?.profiles)) {
            throw fail('RESTORE_RECOVERY_FAILED', 'Invalid restore journal; preserve it for local repair', 503);
        }
        for (const id of journal.ids) identifier(id);
        const names = new Set();
        for (const swap of journal.swaps) {
            if (!journal.ids.includes(swap.id) || !ROOTS.has(swap.name) || typeof swap.hadOriginal !== 'boolean' || names.has(swap.id + '/' + swap.name)) {
                throw fail('RESTORE_RECOVERY_FAILED', 'Invalid restore journal operation', 503);
            }
            names.add(swap.id + '/' + swap.name); this.journalPaths(journal, swap);
        }
        for (const item of journal.previous.profiles) {
            if (!journal.ids.includes(item.id)) throw fail('RESTORE_RECOVERY_FAILED', 'Invalid restore journal account', 503);
            profile({}, item);
        }
        return journal;
    }
    removeStage(journal) {
        const stage = workspacePath(this.root, journal.stage);
        if (fs.existsSync(stage)) {
            if (fs.lstatSync(stage).isSymbolicLink()) throw fail('RESTORE_RECOVERY_FAILED', 'Restore stage is a symbolic link', 503);
            fs.rmSync(stage, { recursive: true }); syncDirectory(path.dirname(stage));
        }
        fs.unlinkSync(this.journalFile); syncDirectory(path.dirname(this.journalFile));
    }
    recover() {
        if (!fs.existsSync(this.journalFile)) return;
        const journal = this.validateJournal(read(this.journalFile));
        if (journal.phase === 'committed' || journal.phase === 'rolled_back') { this.removeStage(journal); return; }
        for (const id of journal.ids) {
            if (this.accounts.processes.has(id)) throw fail('RESTORE_RECOVERY_REQUIRED', 'Stop affected instances before recovering restore', 409);
            this.accounts.assertStopped?.(id);
        }
        journal.phase = 'rolling_back'; atomic(this.journalFile, journal);
        for (const swap of [...journal.swaps].reverse()) {
            const { current, old, replacement } = this.journalPaths(journal, swap);
            for (const candidate of [current, old, replacement]) if (fs.existsSync(candidate) &&
                (fs.lstatSync(candidate).isSymbolicLink() || !fs.lstatSync(candidate).isDirectory())) throw fail('RESTORE_RECOVERY_FAILED', 'Restore directories require local repair', 503);
            if (fs.existsSync(old)) {
                if (fs.existsSync(current)) { fs.rmSync(current, { recursive: true }); syncDirectory(path.dirname(current)); }
                durableRename(old, current);
            } else if (!swap.hadOriginal && !fs.existsSync(replacement) && fs.existsSync(current)) {
                fs.rmSync(current, { recursive: true }); syncDirectory(path.dirname(current));
            }
            this.checkpoint('after_rollback_swap');
        }
        // Merge only affected accounts: unrelated settings may have changed while encryption was awaiting.
        const previous = new Map(journal.previous.profiles.map(item => [item.id, structuredClone(item)]));
        const originalPositions = this.accounts.document.profiles.map(item => item.id);
        this.accounts.document.profiles = this.accounts.document.profiles.filter(item => !journal.ids.includes(item.id));
        for (const id of journal.ids) {
            delete this.accounts.document.maintenance[id];
            if (previous.has(id)) {
                const item = previous.get(id); item.desired = 'stopped';
                this.accounts.document.profiles.push(item);
                this.accounts.document.maintenance[id] = { operation: 'restore', phase: 'rolled_back', at: Date.now() };
                this.accounts.states.set(id, 'maintenance_interrupted');
            } else this.accounts.states.delete(id);
        }
        // Display allocation depends on stable registry order; do not move restored accounts past live peers.
        const positions = new Map(originalPositions.map((id, index) => [id, index]));
        this.accounts.document.profiles.sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER));
        this.accounts.persist();
        journal.phase = 'rolled_back'; atomic(this.journalFile, journal);
        this.removeStage(journal);
        this.recoveryError = null;
    }
    list() {
        return fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{32}\.json$/.test(name)).map(name => read(path.join(this.directory, name)));
    }
    file(id) { identifier(id); if (!/^[a-f0-9]{32}$/.test(id)) throw fail('NOT_FOUND', 'Backup not found', 404); return path.join(this.directory, id + '.fwd'); }
    checkedFiles(id) {
        const archive = this.file(id), metadata = path.join(this.directory, id + '.json');
        const relative = path.relative(path.resolve(this.root), this.directory);
        if (relative !== path.join('work', 'backups')) throw fail('UNSAFE_BACKUP_PATH', 'Backup directory must remain inside work/backups', 409);
        let current = path.resolve(this.root);
        for (const name of ['', ...relative.split(path.sep)]) {
            if (name) current = path.join(current, name);
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink() || !stat.isDirectory() || path.relative(current, fs.realpathSync(current)) !== '') {
                throw fail('UNSAFE_BACKUP_PATH', 'Backup directories cannot contain links or redirected paths', 409);
            }
        }
        const files = [archive, metadata].map(file => {
            let stat;
            try { stat = fs.lstatSync(file); }
            catch (error) { if (error.code === 'ENOENT') return { file, stat: null }; throw error; }
            if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || path.relative(file, fs.realpathSync(file)) !== '') {
                throw fail('UNSAFE_BACKUP_PATH', 'Backup files must be ordinary files without links', 409);
            }
            return { file, stat };
        });
        if (files.every(item => !item.stat)) throw fail('NOT_FOUND', 'Backup not found', 404);
        return files;
    }
    download(id) {
        this.assertOpen();
        if (this.locked) throw fail('BUSY', 'Another backup operation is running', 409);
        const [{ file, stat }] = this.checkedFiles(id);
        if (!stat) throw fail('NOT_FOUND', 'Backup archive not found', 404);
        const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        let stream;
        try {
            const opened = fs.fstatSync(descriptor);
            if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) {
                throw fail('UNSAFE_BACKUP_PATH', 'Backup file changed while opening', 409);
            }
            stream = fs.createReadStream(file, { fd: descriptor, autoClose: true });
        } catch (error) { fs.closeSync(descriptor); throw error; }
        this.downloads.set(id, (this.downloads.get(id) || 0) + 1);
        this.downloadStreams.add(stream);
        stream.once('close', () => {
            this.downloadStreams.delete(stream);
            const count = (this.downloads.get(id) || 1) - 1;
            if (count > 0) this.downloads.set(id, count); else this.downloads.delete(id);
        });
        return stream;
    }
    remove(id) {
        this.assertOpen();
        if (this.locked || this.downloads.has(id)) throw fail('BUSY', 'This backup is being used by another operation', 409);
        if (this.recoveryError || fs.existsSync(this.journalFile)) throw fail('RESTORE_RECOVERY_REQUIRED', 'Finish interrupted restore recovery before deleting backups', 409);
        const files = this.checkedFiles(id);
        this.locked = true;
        try {
            if ([...this.previews.values()].some(preview => preview.backupId === id)) this.clearPreviews();
            // No awaits: validation and deletion share the same manager lock.
            // Only these two exact files are removed; account state is untouched.
            for (const item of files) if (item.stat) fs.unlinkSync(item.file);
            syncDirectory(this.directory);
            return { id, deleted: true };
        } finally { this.locked = false; }
    }
    save(bytes, metadata) {
        this.assertOpen();
        const id = crypto.randomBytes(16).toString('hex'), file = this.file(id);
        const descriptor = fs.openSync(file, 'wx', 0o600);
        try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
        syncDirectory(this.directory);
        const info = { id, at: Date.now(), bytes: bytes.length, sha256: hash(bytes), ...metadata };
        atomic(path.join(this.directory, id + '.json'), info); return info;
    }
    upload(bytes) {
        if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARCHIVE || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw fail('INVALID_BACKUP', 'Invalid backup upload');
        return this.save(bytes, { kind: bytes[MAGIC.length] === 1 ? 'full' : 'ordinary', uploaded: true });
    }
    create(options) { return this.track(() => this.createBackup(options)); }
    async createBackup({ profileIds, kind = 'ordinary', password } = {}) {
        if (this.locked) throw fail('BUSY', 'Another backup operation is running', 409);
        this.ensureRecovered();
        if (!Array.isArray(profileIds) || !profileIds.length || new Set(profileIds).size !== profileIds.length || !['ordinary', 'full'].includes(kind)) throw fail('INVALID_PARAMS', 'Select accounts and a backup kind');
        if (kind === 'full' && (typeof password !== 'string' || password.length < 12 || password.length > 1024)) throw fail('INVALID_PASSWORD', 'Backup password requires 12 to 1024 characters');
        for (const id of profileIds) this.accounts.get(id);
        let estimated = 0;
        for (const id of profileIds) for (const entry of gather(this.accounts.location(id), kind, { sizeOnly: true })) estimated += entry.size;
        if (estimated > MAX) throw fail('BACKUP_LIMIT', 'Selected accounts exceed the total backup size limit');
        // Metadata preflight needs little memory; the larger allocation check
        // runs after selected QQ writers have released their memory.
        this.admit();
        this.locked = true;
        const existingMaintenance = new Map(profileIds.map(id => [id, this.accounts.document.maintenance[id]]));
        try {
            // Both kinds stop writers, so ID mappings and account configuration describe one point in time.
            await this.accounts.maintain(profileIds, 'backup');
            this.assertOpen();
            for (const id of profileIds) {
                const data = path.join(this.accounts.location(id), 'data');
                if (fs.existsSync(data)) {
                    const { checkpointDirectory } = require('../onebot/store.cjs');
                    if (typeof checkpointDirectory === 'function') checkpointDirectory(data);
                    else if (fs.readdirSync(data).some(name => /\.json\.wal$/.test(name) && fs.statSync(path.join(data, name)).size)) {
                        throw fail('CHECKPOINT_REQUIRED', 'Message journal requires a compatible checkpoint implementation', 409);
                    }
                }
            }
            estimated = 0;
            for (const id of profileIds) for (const entry of gather(this.accounts.location(id), kind, { sizeOnly: true })) estimated += entry.size;
            if (estimated > MAX) throw fail('BACKUP_LIMIT', 'Selected accounts exceed the total backup size limit');
            this.admit(estimated);
            const document = { version: 2, architecture: 'x64', qqVersion: '3.2.35-54395', kind, at: Date.now(), profiles: profileIds.map(id => {
                const config = structuredClone(this.accounts.get(id));
                if (kind === 'ordinary') {
                    config.nodes = config.nodes.map(({ token, secret, ...node }) => ({ ...node, enabled: false }));
                    if (config.notifications) config.notifications.enabled = false;
                }
                return { config, entries: gather(this.accounts.location(id), kind) };
            }) };
            validateArchive(document);
            const result = this.save(await encode(document, password), { kind, profileIds });
            await this.accounts.finishMaintenance(profileIds, { success: true, resume: true });
            return result;
        } catch (error) {
            const acquired = profileIds.filter(id => this.accounts.document.maintenance[id] && this.accounts.document.maintenance[id] !== existingMaintenance.get(id));
            if (acquired.length) await this.accounts.finishMaintenance(acquired, { success: false }).catch(() => {});
            throw error;
        } finally { this.locked = false; }
    }
    preview(options) { return this.track(() => this.previewBackup(options)); }
    async previewBackup({ backupId, password } = {}) {
        if (this.locked) throw fail('BUSY', 'Another backup operation is running', 409);
        this.clearPreviews();
        this.ensureRecovered();
        const [{ file, stat }] = this.checkedFiles(backupId);
        if (!stat) throw fail('NOT_FOUND', 'Backup archive not found', 404);
        const maxOutputLength = this.admit(stat.size);
        this.locked = true;
        try {
            const document = await decode(fs.readFileSync(file), password, { maxOutputLength });
            this.assertOpen();
            this.clearPreviews();
            const id = crypto.randomBytes(24).toString('base64url');
            this.previews.set(id, { backupId, document, expires: this.now() + this.previewMs });
            // Full previews contain decrypted login state. Drop the retained
            // document on expiry even if no later API request arrives.
            this.previewTimer = setTimeout(() => this.clearPreviews(), this.previewMs);
            this.previewTimer.unref?.();
            return { previewId: id, backupId, kind: document.kind, qqVersion: document.qqVersion,
                profiles: document.profiles.map(item => ({ id: item.config.id, label: item.config.label, uin: item.config.boundUin || item.config.expectedUin,
                    files: item.entries.length, existing: this.accounts.document.profiles.some(old => old.id === item.config.id) })) };
        } finally { this.locked = false; }
    }
    apply(previewId, backupId) { return this.track(() => this.applyBackup(previewId, backupId)); }
    async applyBackup(previewId, backupId) {
        if (this.locked) throw fail('BUSY', 'Another backup operation is running', 409);
        const preview = this.previews.get(previewId); this.clearPreviews();
        if (!preview || preview.expires <= this.now()) throw fail('PREVIEW_EXPIRED', 'Preview expired; inspect the backup again');
        if (backupId !== undefined && preview.backupId !== backupId) throw fail('PREVIEW_MISMATCH', 'Selected backup does not match the validated preview', 409);
        this.admit(preview.document.profiles.reduce((total, item) => total + item.entries.reduce((size, entry) => size + entry.size, 0), 0));
        this.ensureRecovered();
        const document = preview.document, ids = document.profiles.map(item => item.config.id);
        const relative = 'work/temp/restore-' + crypto.randomBytes(16).toString('hex');
        const stage = privateDirectory(this.root, relative);
        this.locked = true;
        const journal = { version: 1, phase: 'staging', stage: relative, ids, swaps: [],
            previous: { profiles: structuredClone(this.accounts.document.profiles.filter(item => ids.includes(item.id))) } };
        try {
            atomic(this.journalFile, journal);
            for (const item of document.profiles) {
                const id = item.config.id;
                if (!this.accounts.document.profiles.some(old => old.id === id)) this.accounts.create({ id, label: item.config.label, expectedUin: item.config.expectedUin });
                const target = path.join(stage, id); fs.mkdirSync(target, { mode: 0o700 });
                for (const name of ROOTS) fs.mkdirSync(path.join(target, name), { mode: 0o700 });
                syncDirectory(target); syncDirectory(stage);
                for (const entry of item.entries) {
                    const file = path.join(target, ...safeName(entry.name).split('/'));
                    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
                    const descriptor = fs.openSync(file, 'wx', 0o600);
                    try { fs.writeFileSync(descriptor, Buffer.from(entry.data, 'base64')); fs.fsyncSync(descriptor); }
                    finally { fs.closeSync(descriptor); }
                    syncDirectory(path.dirname(file));
                }
            }
            await this.accounts.maintain(ids, 'restore');
            this.assertOpen();
            for (const id of ids) this.accounts.assertStopped?.(id);
            journal.phase = 'swapping'; atomic(this.journalFile, journal);
            for (const item of document.profiles) {
                const base = this.accounts.location(item.config.id);
                // Rollback directories remain private until the transaction is committed.
                for (const name of ROOTS) {
                    const current = path.join(base, name), replacement = path.join(stage, item.config.id, name), old = path.join(stage, item.config.id, 'old-' + name);
                    if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink() || !fs.lstatSync(current).isDirectory())) throw fail('UNSAFE_FILE', 'Restore target must be an ordinary directory');
                    const swap = { id: item.config.id, name, hadOriginal: fs.existsSync(current) };
                    journal.swaps.push(swap); atomic(this.journalFile, journal);
                    if (swap.hadOriginal) durableRename(current, old);
                    this.checkpoint('after_old_rename');
                    durableRename(replacement, current);
                    this.checkpoint('after_new_rename');
                }
                const restored = { ...item.config, desired: 'stopped', revision: (this.accounts.get(item.config.id).revision || 0) + 1 };
                if (document.kind === 'ordinary') {
                    restored.nodes = restored.nodes.map(node => ({ ...node, token: '', secret: '', enabled: false }));
                    if (restored.notifications) restored.notifications = { ...restored.notifications, enabled: false };
                }
                Object.assign(this.accounts.get(item.config.id), restored);
            }
            this.accounts.persist();
            this.checkpoint('after_registry_persist');
            await this.accounts.finishMaintenance(ids, { success: true });
            journal.phase = 'committed'; atomic(this.journalFile, journal);
            this.checkpoint('after_commit');
            this.removeStage(journal);
            return { restored: ids, started: false };
        } catch (error) {
            try { this.recover(); }
            catch (recovery) { this.recoveryError = recovery.code || 'RESTORE_RECOVERY_FAILED'; throw fail('RESTORE_RECOVERY_FAILED', 'Restore interrupted; private journal retained for recovery', 503); }
            throw error;
        } finally {
            // Never delete rollback state while a durable journal still references it.
            this.locked = false;
        }
    }
    close() {
        if (this.closingPromise) return this.closingPromise;
        this.closed = true;
        this.clearPreviews();
        for (const stream of this.downloadStreams) stream.destroy();
        this.closingPromise = Promise.allSettled([...this.pending]).then(() => {
            this.clearPreviews();
            for (const stream of this.downloadStreams) stream.destroy();
        });
        return this.closingPromise;
    }
}
module.exports = { Backups, encode, decode, validateArchive, gather, ordinaryMapping, MAX_ARCHIVE };
