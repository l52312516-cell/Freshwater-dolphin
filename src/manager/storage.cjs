'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomic, fail } = require('./files.cjs');
const { ordinaryMapping } = require('./backups.cjs');
const ownership = require('./ownership.cjs');

const MIB = 1024 * 1024;
const DEFAULT_POLICY = { logMaxMiB: 1024, logRetentionDays: 7, enabled: false };
const MAX_ACCOUNTS = 16;
const MAX_ENTRIES = 20000;
const MAX_SCAN_MS = 500;
const LOG_NAME = /\.(?:log|jsonl)(?:\.\d+)?$/i;
const MAPPING_NAME = /^[1-9]\d{0,15}\.json$/;

function policy(input = DEFAULT_POLICY) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        !Number.isInteger(input.logMaxMiB) || input.logMaxMiB < 1 || input.logMaxMiB > 102400 ||
        !Number.isInteger(input.logRetentionDays) || input.logRetentionDays < 0 || input.logRetentionDays > 3650 ||
        (input.enabled !== undefined && typeof input.enabled !== 'boolean')) {
        throw fail('INVALID_STORAGE_POLICY', 'Use 1 to 102400 MiB and 0 to 3650 retention days');
    }
    return { logMaxMiB: input.logMaxMiB, logRetentionDays: input.logRetentionDays, enabled: input.enabled === true };
}

class Storage {
    constructor(root, accounts, { settings = {}, settingsFile = path.join(root, 'work/control/settings.json'), backups,
        intervalMs = 5 * 60 * 1000, maxEntries = MAX_ENTRIES, maxScanMs = MAX_SCAN_MS } = {}) {
        this.root = path.resolve(root); this.work = path.join(this.root, 'work'); this.accounts = accounts;
        this.settings = settings; this.settingsFile = settingsFile; this.backups = backups;
        this.intervalMs = intervalMs; this.maxEntries = maxEntries; this.maxScanMs = maxScanMs;
        this.active = false; this.closed = false; this.timer = null; this.lastCleanup = null;
        this.currentPolicy = policy(settings.storage === undefined ? DEFAULT_POLICY : settings.storage);
        this.device = this.checked(this.work).dev;
    }

    // Validate every component. lstat rejects symlinks/junctions, while realpath
    // also rejects redirected/reparse paths that do not retain their spelling.
    checked(target, missing = false) {
        const absolute = path.resolve(target), relative = path.relative(this.work, absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw fail('UNSAFE_STORAGE_PATH', 'Storage paths must stay inside work/', 409);
        const names = path.relative(this.root, absolute).split(path.sep);
        let current = this.root;
        for (const name of ['', ...names]) {
            if (name) current = path.join(current, name);
            let info;
            try { info = fs.lstatSync(current); }
            catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
            if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1 || (!info.isFile() && !info.isDirectory()) ||
                path.relative(current, fs.realpathSync(current)) !== '') throw fail('UNSAFE_STORAGE_PATH', 'Links and special storage files are excluded', 409);
            const fromWork = path.relative(this.work, current);
            if (this.device !== undefined && !fromWork.startsWith('..') && !path.isAbsolute(fromWork) && info.dev !== this.device) {
                throw fail('UNSAFE_STORAGE_PATH', 'Storage cleanup cannot cross a mounted filesystem', 409);
            }
        }
        return fs.lstatSync(absolute);
    }

    budget() { return { entries: 0, files: 0, deadline: Date.now() + this.maxScanMs, partial: false }; }
    scan(directory, budget, accept = () => true, recursive = true) {
        const result = { bytes: 0, files: 0, scanned: false, partial: false, items: [] };
        const visit = (target, depth) => {
            if (budget.entries > this.maxEntries || Date.now() > budget.deadline || depth > 10) {
                result.partial = budget.partial = true; return;
            }
            let info;
            try { info = this.checked(target, true); }
            catch { result.partial = budget.partial = true; return; }
            if (!info) { if (depth === 0) result.scanned = true; return; }
            if (depth === 0) {
                if (!info.isDirectory()) { result.partial = budget.partial = true; return; }
                result.scanned = true;
            }
            if (info.isFile()) {
                if (!accept(path.basename(target))) return;
                result.bytes += info.size; result.files++; budget.files++;
                result.items.push({ file: target, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev });
                return;
            }
            let handle;
            try {
                handle = fs.opendirSync(target);
                let entry;
                while ((entry = handle.readSync()) !== null) {
                    if (budget.entries >= this.maxEntries || Date.now() > budget.deadline) { result.partial = budget.partial = true; break; }
                    budget.entries++;
                    if (!recursive && entry.isDirectory()) continue;
                    visit(path.join(target, entry.name), depth + 1);
                }
            } catch { result.partial = budget.partial = true; }
            finally { if (handle) handle.closeSync(); }
        };
        visit(directory, 0);
        return result;
    }

    blocked(id) {
        const item = this.accounts.get(id);
        if (this.closed || this.accounts.closing) return 'CLOSING';
        if (this.backups?.locked) return 'BACKUP_BUSY';
        if (this.accounts.document.maintenance[id]) return 'MAINTENANCE';
        if (this.accounts.busy.has(id)) return 'BUSY';
        if (item.desired !== 'stopped' || this.accounts.processes.has(id) || this.accounts.stopping.has(id)) return 'ACCOUNT_RUNNING';
        try {
            this.accounts.assertRemovalAvailable(id);
            const base = this.accounts.location(id);
            this.checked(path.join(base, 'state'), true);
            const state = ownership.inspect(base);
            if (state.owner || state.groups.length) return 'ACTIVE_PROCESSES';
        } catch (error) { return error.code || 'PROCESS_OWNERSHIP'; }
        return null;
    }

    snapshot() {
        const budget = this.budget();
        const totals = { logsBytes: 0, historyBytes: 0, mediaBytes: 0, totalBytes: 0, files: 0 };
        const summary = value => ({ bytes: value.bytes, files: value.files, scanned: value.scanned, partial: value.partial });
        const globalLogs = this.scan(path.join(this.work, 'logs'), budget);
        totals.logsBytes += globalLogs.bytes; totals.files += globalLogs.files;
        const profiles = this.accounts.document.profiles.slice(0, MAX_ACCOUNTS);
        if (profiles.length < this.accounts.document.profiles.length) budget.partial = true;
        const accounts = profiles.map(item => {
            let base;
            try { base = this.accounts.location(item.id); this.checked(base, true); }
            catch { budget.partial = true; }
            const skipped = () => ({ bytes: 0, files: 0, scanned: false, partial: true });
            const logs = base ? this.scan(path.join(base, 'logs'), budget) : skipped();
            const history = base ? this.scan(path.join(base, 'data'), budget, name => MAPPING_NAME.test(name), false) : skipped();
            const media = base ? this.scan(path.join(base, 'media'), budget) : skipped();
            totals.logsBytes += logs.bytes; totals.historyBytes += history.bytes; totals.mediaBytes += media.bytes;
            totals.files += logs.files + history.files + media.files;
            const blockedReason = base ? this.blocked(item.id) : 'UNSAFE_STORAGE_PATH';
            return { profileId: item.id, label: item.label, uin: item.boundUin || item.expectedUin || null,
                state: this.accounts.states.get(item.id) || 'stopped', canClean: blockedReason === null, blockedReason,
                totalBytes: logs.bytes + history.bytes + media.bytes, logs: summary(logs), history: summary(history), media: summary(media) };
        });
        totals.totalBytes = totals.logsBytes + totals.historyBytes + totals.mediaBytes;
        return { policy: { ...this.currentPolicy }, totals, globalLogs: summary(globalLogs), accounts,
            scanned: { accounts: profiles.length, files: budget.files, entries: budget.entries }, partial: budget.partial, lastCleanup: this.lastCleanup };
    }

    updatePolicy(input) {
        if (this.closed) throw fail('CLOSING', 'Storage service is stopping', 503);
        if (this.active) throw fail('BUSY', 'Finish the current cleanup before changing its policy', 409);
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).some(key => !['logMaxMiB', 'logRetentionDays'].includes(key))) throw fail('INVALID_STORAGE_POLICY', 'Only logMaxMiB and logRetentionDays may be changed');
        const next = policy({ ...this.currentPolicy, ...input, enabled: true });
        this.checked(this.settingsFile, true);
        atomic(this.settingsFile, { ...this.settings, storage: next });
        this.settings.storage = next; this.currentPolicy = next;
        return { policy: { ...next } };
    }

    unchanged(item) {
        const info = this.checked(item.file, true);
        if (!info || !info.isFile() || info.ino !== item.ino || info.dev !== item.dev || info.size !== item.size || info.mtimeMs !== item.mtimeMs) {
            throw fail('STORAGE_CHANGED', 'A storage file changed during cleanup', 409);
        }
        return info;
    }
    readFile(item) {
        this.unchanged(item);
        const fd = fs.openSync(item.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
            const info = fs.fstatSync(fd);
            if (!info.isFile() || info.ino !== item.ino || info.dev !== item.dev || info.size !== item.size) throw fail('STORAGE_CHANGED', 'Storage file identity changed', 409);
            return fs.readFileSync(fd);
        } finally { fs.closeSync(fd); }
    }
    result(scope, details = {}) {
        return { at: Date.now(), scope, ...details, deletedFiles: 0, changedFiles: 0, reclaimedBytes: 0, skipped: 0, partial: false };
    }
    cleanLogs() {
        const result = this.result('logs'), budget = this.budget();
        const collections = [this.scan(path.join(this.work, 'logs'), budget)];
        const profiles = this.accounts.document.profiles.slice(0, MAX_ACCOUNTS);
        if (profiles.length < this.accounts.document.profiles.length) budget.partial = true;
        for (const item of profiles) {
            try { collections.push(this.scan(path.join(this.accounts.location(item.id), 'logs'), budget)); }
            catch { result.partial = true; result.skipped++; }
        }
        const items = collections.flatMap(value => value.items).sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
        let remaining = items.reduce((size, item) => size + item.size, 0);
        const cutoff = this.currentPolicy.logRetentionDays === 0 ? -Infinity : Date.now() - this.currentPolicy.logRetentionDays * 86400000;
        const maximum = this.currentPolicy.logMaxMiB * MIB;
        for (const item of items) {
            if (!item.size || item.mtimeMs >= cutoff && remaining <= maximum) continue;
            if (!LOG_NAME.test(path.basename(item.file))) { result.skipped++; result.partial = true; continue; }
            try {
                this.unchanged(item);
                if (/\.\d+$/.test(item.file)) { fs.unlinkSync(item.file); result.deletedFiles++; }
                else {
                    // An open append-only log writer must not retain an unlinked
                    // inode. Truncation also works for QQ's persistent stdout fd.
                    const fd = fs.openSync(item.file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
                    try {
                        const current = fs.fstatSync(fd);
                        if (!current.isFile() || current.ino !== item.ino || current.dev !== item.dev || current.size !== item.size) throw fail('STORAGE_CHANGED', 'Log changed during cleanup', 409);
                        fs.ftruncateSync(fd, 0); fs.fsyncSync(fd); result.changedFiles++;
                    } finally { fs.closeSync(fd); }
                }
                remaining -= item.size; result.reclaimedBytes += item.size;
            } catch { result.skipped++; result.partial = true; }
        }
        result.partial ||= budget.partial || collections.some(item => item.partial);
        return result;
    }

    cleanHistory(id) {
        const result = this.result('account', { profileId: id, category: 'history', clearedMessages: 0 });
        const scan = this.scan(path.join(this.accounts.location(id), 'data'), this.budget(), name => MAPPING_NAME.test(name), false);
        if (scan.partial || scan.files > 256 || scan.bytes > 128 * MIB) throw fail('STORAGE_LIMIT', 'Message mappings could not be fully checked; nothing was cleared', 409);
        // Validate every mapping before changing any. Never remove nextId or an
        // allocated ID/native locator, even if every cached message is erased.
        const prepared = scan.items.map(item => {
            if (item.size > 32 * MIB) throw fail('STORAGE_LIMIT', 'A message mapping exceeds the safe cleanup limit', 409);
            const bytes = this.readFile(item);
            let stripped;
            try { stripped = ordinaryMapping(bytes, path.basename(item.file, '.json'), { strip: true }); }
            catch { throw fail('INVALID_MESSAGE_STORE', 'A message mapping could not be validated; nothing was cleared', 409); }
            const source = JSON.parse(bytes.toString('utf8'));
            return { item, stripped, cleared: source.entries.filter(entry => entry.record || entry.event || entry.recallEvent).length };
        });
        for (const { item, stripped, cleared } of prepared) {
            if (!cleared) continue;
            try {
                this.unchanged(item); atomic(item.file, stripped.toString('utf8'));
                result.changedFiles++; result.clearedMessages += cleared;
                result.reclaimedBytes += Math.max(0, item.size - fs.statSync(item.file).size);
            } catch { result.skipped++; result.partial = true; }
        }
        return result;
    }
    cleanMedia(id) {
        const result = this.result('account', { profileId: id, category: 'media' });
        const scan = this.scan(path.join(this.accounts.location(id), 'media'), this.budget());
        result.partial = scan.partial;
        for (const item of scan.items) {
            try { this.unchanged(item); fs.unlinkSync(item.file); result.deletedFiles++; result.reclaimedBytes += item.size; }
            catch { result.skipped++; result.partial = true; }
        }
        return result;
    }

    async cleanup(input) {
        if (this.closed) throw fail('CLOSING', 'Storage service is stopping', 503);
        if (!input || typeof input !== 'object' || Array.isArray(input) || !['logs', 'account'].includes(input.scope)) throw fail('INVALID_PARAMS', 'Choose logs or account storage');
        const keys = input.scope === 'logs' ? ['scope'] : ['scope', 'profileId', 'category', 'confirmId'];
        if (Object.keys(input).some(key => !keys.includes(key))) throw fail('INVALID_PARAMS', 'Unsupported cleanup parameter');
        if (this.active) throw fail('BUSY', 'Storage cleanup is already running', 409);
        if (input.scope === 'account') {
            this.accounts.get(input.profileId);
            if (!['history', 'media'].includes(input.category)) throw fail('INVALID_PARAMS', 'Choose history or media explicitly');
            if (input.confirmId !== input.profileId) throw fail('CONFIRMATION_REQUIRED', 'Enter the exact account instance ID before clearing its data', 409);
            const reason = this.blocked(input.profileId);
            if (reason) throw fail(reason, 'Stop the account and finish other operations before clearing its data', 409);
        }
        this.active = true;
        try {
            const result = input.scope === 'logs' ? this.cleanLogs() : await this.accounts.operate(input.profileId, () => {
                if (this.closed) throw fail('CLOSING', 'Storage service is stopping', 503);
                if (this.backups?.locked) throw fail('BACKUP_BUSY', 'A backup operation is running', 409);
                if (this.accounts.processes.has(input.profileId) || this.accounts.get(input.profileId).desired !== 'stopped') throw fail('ACCOUNT_RUNNING', 'The account must be fully stopped', 409);
                this.accounts.assertRemovalAvailable(input.profileId); this.accounts.assertStopped(input.profileId);
                return input.category === 'history' ? this.cleanHistory(input.profileId) : this.cleanMedia(input.profileId);
            });
            this.lastCleanup = result; return result;
        } finally { this.active = false; }
    }
    start() {
        if (this.closed || this.timer) return;
        this.timer = setInterval(() => {
            if (this.currentPolicy.enabled && !this.active) this.cleanup({ scope: 'logs' }).catch(() => {});
        }, this.intervalMs);
        this.timer.unref();
    }
    close() { this.closed = true; clearInterval(this.timer); this.timer = null; }
}

module.exports = { Storage, DEFAULT_POLICY, MAX_ACCOUNTS };
