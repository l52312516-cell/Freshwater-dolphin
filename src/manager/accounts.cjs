'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { atomic, read, fail, privateDirectory, identifier, expectedUin, durableRename, syncDirectory } = require('./files.cjs');
const { nodeConfig } = require('../config.cjs');
const { workspacePath } = require('../paths.cjs');
const ownership = require('./ownership.cjs');
const { memoryAvailable } = require('./resources.cjs');
const { prepare } = require('../../tools/prepare-qq.cjs');

function sanitize(profile) {
    return { ...profile, bridgeInstalled: profile.bridgeInstalled !== false,
        nodes: profile.nodes.map(({ token, secret, ...node }) => ({ ...node, tokenPresent: Boolean(token), secretPresent: Boolean(secret) })) };
}
function displayOccupied(display) {
    return process.platform === 'linux' &&
        (fs.existsSync('/tmp/.X11-unix/X' + display) || fs.existsSync('/tmp/.X' + display + '-lock'));
}
function ownedDirectory(root, target, { missing = false } = {}) {
    const absolute = workspacePath(root, target);
    const relative = path.relative(path.resolve(root), absolute);
    let current = path.resolve(root);
    for (const name of relative.split(path.sep)) {
        current = path.join(current, name);
        let stat;
        try { stat = fs.lstatSync(current); }
        catch (error) { if (missing && error.code === 'ENOENT') return absolute; throw error; }
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('UNSAFE_ACCOUNT_PATH', 'Account cleanup paths must be ordinary private directories', 409);
    }
    return absolute;
}
function nodes(values, previous = []) {
    if (!Array.isArray(values) || values.length > 64) throw fail('INVALID_CONFIG', 'Expected at most 64 nodes');
    const result = values.map((value, index) => {
        const old = previous.find(node => node.id === value.id);
        const actual = { ...value };
        if (!Object.hasOwn(actual, 'label') && !Object.hasOwn(actual, 'name') && old?.label !== undefined) actual.label = old.label;
        if (!Object.hasOwn(actual, 'token') && old) actual.token = old.token;
        if (!Object.hasOwn(actual, 'secret') && old) actual.secret = old.secret;
        const normalized = nodeConfig(actual, index);
        if (actual.secret !== undefined) {
            if (typeof actual.secret !== 'string' || actual.secret.length > 4096) throw fail('INVALID_CONFIG', 'Invalid HTTP signing secret');
            normalized.secret = actual.secret;
        }
        if (actual.quickOperations !== undefined) normalized.quickOperations = actual.quickOperations === true;
        return normalized;
    });
    if (new Set(result.map(node => node.id)).size !== result.length) throw fail('INVALID_CONFIG', 'Duplicate node identifier');
    for (const node of result) if (node.enabled && ['httpApi', 'wsServer'].includes(node.type) && !node.token) {
        throw fail('TOKEN_REQUIRED', 'Public OneBot listeners require a token');
    }
    return result;
}
function notificationSelection(value = { enabled: false, channelIds: [] }) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !['enabled', 'channelIds'].includes(key)) ||
        typeof value.enabled !== 'boolean' || !Array.isArray(value.channelIds) || value.channelIds.length > 32 ||
        value.channelIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) ||
        new Set(value.channelIds).size !== value.channelIds.length) {
        throw fail('INVALID_CONFIG', 'Invalid account notification selection');
    }
    return { enabled: value.enabled, channelIds: [...value.channelIds] };
}
function profile(input, existing = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_CONFIG', 'Expected account configuration');
    if (Object.hasOwn(input, 'bridgeInstalled')) throw fail('INVALID_CONFIG', 'Use the dedicated bridge install or uninstall operation');
    if (existing.bridgeInstalled !== undefined && typeof existing.bridgeInstalled !== 'boolean') throw fail('INVALID_CONFIG', 'Invalid bridge installation state');
    const id = identifier(existing.id || input.id || crypto.randomBytes(8).toString('hex'));
    const label = input.label === undefined ? existing.label || id : input.label;
    if (typeof label !== 'string' || label.length > 100 || /[\u0000-\u001f]/.test(label)) throw fail('INVALID_CONFIG', 'Invalid account label');
    const timeout = input.actionTimeoutMs ?? existing.actionTimeoutMs ?? 10000;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000) throw fail('INVALID_CONFIG', 'Invalid action timeout');
    return { id, label, expectedUin: expectedUin(input.expectedUin === undefined ? existing.expectedUin : input.expectedUin),
        boundUin: existing.boundUin || null, desired: existing.desired || 'stopped', revision: (existing.revision || 0) + 1,
        bridgeInstalled: existing.bridgeInstalled !== false,
        actionTimeoutMs: timeout, nodes: nodes(input.nodes === undefined ? existing.nodes || [] : input.nodes, existing.nodes),
        notifications: notificationSelection(input.notifications === undefined ? existing.notifications : input.notifications) };
}

class Accounts {
    constructor(root, { spawnAccount, memory = memoryAvailable, maxAccounts = 2, onChange = () => {}, displayBusy = displayOccupied, prepareQQ = prepare } = {}) {
        this.root = root;
        this.control = privateDirectory(root, 'work/control');
        this.directory = privateDirectory(root, 'work/accounts');
        this.file = path.join(this.control, 'accounts.json');
        this.memory = memory;
        this.maxAccounts = maxAccounts;
        this.onChange = onChange;
        this.spawnAccount = spawnAccount || (options => spawn('bash', [path.join(root, 'deploy/account-entry.sh')], options));
        this.displayBusy = displayBusy;
        this.prepareQQ = prepareQQ;
        this.processes = new Map();
        this.displays = new Map();
        this.healths = new Map();
        this.states = new Map();
        this.retries = new Map();
        this.retryTimers = new Map();
        this.operations = new Map();
        this.stopping = new Set();
        this.busy = new Set();
        this.persistenceBlocked = new Set();
        this.closing = false;
        this.document = read(this.file, { version: 1, profiles: [], maintenance: {} });
        if (this.document.version !== 1 || !Array.isArray(this.document.profiles) || !this.document.maintenance) throw fail('INVALID_CONFIG', 'Invalid account registry');
        const seen = new Set();
        for (const item of this.document.profiles) {
            identifier(item.id); profile({}, item);
            if (seen.has(item.id)) throw fail('INVALID_CONFIG', 'Duplicate account identifier');
            seen.add(item.id);
            this.location(item.id);
            this.clearGrant(item.id);
            this.states.set(item.id, this.document.maintenance[item.id] ? 'maintenance_interrupted' : 'stopped');
        }
    }
    location(id) { return ownedDirectory(this.root, path.join('work/accounts', identifier(id)), { missing: true }); }
    get(id) {
        const item = this.document.profiles.find(item => item.id === identifier(id));
        if (!item) throw fail('NOT_FOUND', 'Account instance not found', 404);
        return item;
    }
    persist() { atomic(this.file, this.document); }
    commitProfile(id, next, { create = false } = {}) {
        const before = structuredClone(this.document);
        const item = create ? next : this.get(id);
        const previous = create ? null : structuredClone(item);
        if (create) this.document.profiles.push(item);
        else Object.assign(item, next);
        try { this.persist(); this.persistenceBlocked.delete(id); return null; }
        catch (error) {
            let durable;
            try { durable = read(this.file); } catch { /* deny authorization until the registry can be repaired */ }
            // rename may have committed before fsync reports an error. Keep the
            // committed state and explicitly return its durability warning.
            if (durable && JSON.stringify(durable) === JSON.stringify(this.document)) {
                this.persistenceBlocked.delete(id); return error.code || 'PERSISTENCE_WARNING';
            }
            if (create) this.document.profiles = this.document.profiles.filter(value => value !== item);
            else { for (const key of Object.keys(item)) delete item[key]; Object.assign(item, previous); }
            if (!durable || JSON.stringify(durable) !== JSON.stringify(before)) {
                this.persistenceBlocked.add(id); this.states.set(id, 'persistence_failed');
                try { this.clearGrant(id); } catch { /* keep blocked in memory even if revocation cannot be written */ }
            }
            throw error;
        }
    }
    list() {
        return this.document.profiles.map(item => ({ ...sanitize(item), state: this.states.get(item.id) || 'stopped',
            health: this.healths.get(item.id) || null, maintenance: this.document.maintenance[item.id] || null }));
    }
    create(input) {
        const item = profile(input);
        if (this.document.profiles.some(old => old.id === item.id)) throw fail('CONFLICT', 'Instance already exists', 409);
        if (this.document.profiles.length >= 32) throw fail('LIMIT', 'At most 32 saved instances are allowed');
        privateDirectory(this.root, path.join('work/accounts', item.id));
        const persistenceWarning = this.commitProfile(item.id, item, { create: true });
        this.states.set(item.id, 'stopped'); this.onChange();
        return { ...sanitize(item), ...(persistenceWarning ? { persistenceWarning } : {}) };
    }
    async update(id, input) {
        return this.operate(id, () => this.updateAccount(id, input));
    }
    async updateNotifications(id, input) {
        const selection = notificationSelection(input);
        return this.operate(id, () => {
            const item = this.get(id);
            this.commitProfile(id, { notifications: selection, revision: item.revision + 1 });
            this.onChange();
            return selection;
        });
    }
    async operate(id, operation) {
        this.get(id);
        if (this.closing) throw fail('CLOSING', 'Manager is stopping', 503);
        if (this.busy.has(id) || this.document.maintenance[id]) throw fail('BUSY', 'Instance has an operation in progress', 409);
        this.busy.add(id);
        this.clearRetry(id);
        const pending = Promise.resolve().then(operation);
        this.operations.set(id, pending);
        try { return await pending; }
        finally { this.busy.delete(id); this.operations.delete(id); }
    }
    async updateAccount(id, input) {
        const item = this.get(id);
        const next = profile(input, item);
        const running = this.processes.has(id);
        if (running) await this.stopAccount(id, { preserveIntent: true });
        let persistenceWarning;
        try { persistenceWarning = this.commitProfile(id, next); }
        catch (error) {
            // A rejected configuration must not silently leave a previously
            // running account stopped when its old durable config is intact.
            if (running && !this.persistenceBlocked.has(id)) {
                try { await this.startAccount(id, { automatic: true }); }
                catch { this.states.set(id, 'apply_failed'); }
            }
            this.onChange(); throw error;
        }
        if (running) {
            try { await this.startAccount(id, { automatic: true }); }
            catch (error) { this.states.set(id, 'apply_failed'); this.onChange(); return { ...sanitize(item), saved: true, applied: false, error: error.code }; }
        }
        this.onChange(); return { ...sanitize(item), saved: true, applied: true, ...(persistenceWarning ? { persistenceWarning } : {}) };
    }
    async install(id) { return this.changeBridge(id, true); }
    async uninstall(id) { return this.changeBridge(id, false); }
    async changeBridge(id, enabled) {
        return this.operate(id, async () => {
            const item = this.get(id), previous = item.bridgeInstalled !== false;
            if (previous === enabled) return { ...sanitize(item), saved: true, applied: true, changed: false };
            const base = this.assertRemovalAvailable(id);
            const appDir = ownedDirectory(this.root, path.join(base, 'qq-root/opt/QQ/resources/app'), { missing: true });
            const running = this.processes.has(id), revision = item.revision;
            await this.stopAccount(id, { preserveIntent: true });
            this.assertStopped(id);
            try {
                if (fs.existsSync(appDir)) this.prepareQQ({ root: this.root, accountRoot: base, appDir, restore: !enabled });
            } catch (error) {
                this.states.set(id, 'bridge_apply_failed'); this.onChange(); throw error;
            }
            item.bridgeInstalled = enabled; item.revision++;
            try { this.persist(); }
            catch (error) {
                let durable;
                try { durable = read(this.file)?.profiles?.find(account => account.id === id); } catch { /* attempt conservative rollback below */ }
                if (durable && durable.bridgeInstalled === enabled) {
                    item.bridgeInstalled = enabled; item.revision = durable.revision;
                    this.states.set(id, 'bridge_apply_failed'); this.onChange(); throw error;
                }
                item.bridgeInstalled = previous; item.revision = revision;
                try {
                    if (fs.existsSync(appDir)) this.prepareQQ({ root: this.root, accountRoot: base, appDir, restore: !previous });
                } catch {
                    this.document.maintenance[id] = { operation: 'bridge', phase: 'rollback_failed', previous: 'stopped', at: Date.now() };
                    try { this.persist(); } catch { /* preserve application ownership evidence for repair */ }
                }
                this.states.set(id, 'bridge_apply_failed'); this.onChange(); throw error;
            }
            if (running) {
                try { await this.startAccount(id, { automatic: true }); }
                catch (error) {
                    this.states.set(id, 'apply_failed'); this.onChange();
                    return { ...sanitize(item), saved: true, applied: false, changed: true, error: error.code || 'START_FAILED' };
                }
            }
            this.onChange(); return { ...sanitize(item), saved: true, applied: true, changed: true };
        });
    }
    allocateDisplay(id) {
        const used = new Set();
        for (const [other, child] of this.processes) {
            if (other === id) continue;
            let display = this.displays.get(other) || child.freshwaterDisplay || child.env?.DISPLAY;
            if (!display && process.platform === 'linux') {
                try {
                    const entries = fs.readFileSync('/proc/' + child.pid + '/environ', 'utf8').split('\0');
                    if (entries.includes('FWD_ACCOUNT_ROOT=' + this.location(other))) display = entries.find(value => value.startsWith('DISPLAY='))?.slice(8);
                } catch { /* An unconfirmed live display must not be guessed. */ }
            }
            if (typeof display !== 'string' || !/^:(?:12\d|13\d|14\d|150|151)$/.test(display)) throw fail('DISPLAY_UNAVAILABLE', 'A live account display could not be verified', 503);
            used.add(Number(display.slice(1)));
        }
        for (const [other, display] of this.displays) if (other !== id) used.add(Number(display.slice(1)));
        for (let display = 120; display <= 151; display++) if (!used.has(display) && !this.displayBusy(display)) return ':' + display;
        throw fail('DISPLAY_UNAVAILABLE', 'No isolated QQ display is available', 503);
    }
    assertRemovalAvailable(id) {
        const journal = read(path.join(this.control, 'restore-journal.json'), null);
        if (journal && (!Array.isArray(journal.ids) || journal.ids.includes(id))) throw fail('MAINTENANCE', 'Restore recovery is pending for this account', 409);
        const base = ownedDirectory(this.root, this.location(id), { missing: true });
        ownedDirectory(this.root, path.join(base, 'state'), { missing: true });
        ownedDirectory(this.root, path.join(this.control, 'deletions'), { missing: true });
        return base;
    }
    async remove(id, { confirmId } = {}) {
        this.get(id);
        if (confirmId !== id) throw fail('CONFIRMATION_REQUIRED', 'Confirm the exact instance identifier before deleting its login and message data', 409);
        return this.operate(id, async () => {
            const base = this.assertRemovalAvailable(id);
            await this.stopAccount(id);
            this.assertStopped(id);
            const transaction = { operation: 'delete', phase: 'staging', previous: 'stopped', at: Date.now(),
                stage: 'work/control/deletions/' + crypto.randomBytes(16).toString('hex'), hadOriginal: fs.existsSync(base) };
            this.document.maintenance[id] = transaction;
            try { this.persist(); }
            catch (error) {
                let durable;
                try { durable = read(this.file)?.maintenance?.[id]; } catch { /* preserve the conservative pending transaction */ }
                if (durable?.operation === 'delete') this.document.maintenance[id] = durable;
                else if (durable === undefined) delete this.document.maintenance[id];
                this.states.set(id, this.document.maintenance[id] ? 'delete_failed' : 'stopped'); this.onChange();
                throw error;
            }
            return this.completeRemoval(id, transaction);
        });
    }
    removalPaths(id, transaction) {
        if (transaction?.operation !== 'delete' || !['staging', 'purging'].includes(transaction.phase) ||
            !/^work\/control\/deletions\/[a-f0-9]{32}$/.test(transaction.stage || '') || typeof transaction.hadOriginal !== 'boolean') {
            throw fail('DELETE_RECOVERY_FAILED', 'Invalid account deletion record; preserve it for local repair', 503);
        }
        const base = this.assertRemovalAvailable(id);
        const stage = ownedDirectory(this.root, transaction.stage, { missing: true });
        const account = ownedDirectory(this.root, path.join(stage, 'account'), { missing: true });
        return { base, stage, account };
    }
    purgeRemovalStage(stage) {
        ownedDirectory(this.root, stage, { missing: true });
        // Recursive rm unlinks nested symbolic links; it never traverses their targets.
        if (fs.existsSync(stage)) { fs.rmSync(stage, { recursive: true }); syncDirectory(path.dirname(stage)); }
    }
    async completeRemoval(id, transaction) {
        try {
            const { base, stage, account } = this.removalPaths(id, transaction);
            this.assertStopped(id);
            if (transaction.phase === 'staging') {
                privateDirectory(this.root, stage);
                const current = fs.existsSync(base), staged = fs.existsSync(account);
                if (current && staged || transaction.hadOriginal && !current && !staged || !transaction.hadOriginal && (current || staged)) {
                    throw fail('DELETE_RECOVERY_FAILED', 'Account deletion paths changed; preserve the recovery directory', 503);
                }
                if (current) durableRename(base, account);
                transaction.phase = 'purging'; this.persist();
            }
            if (fs.existsSync(base)) throw fail('DELETE_RECOVERY_FAILED', 'An account directory reappeared during deletion; preserve it for local repair', 503);
            this.purgeRemovalStage(stage);
            const profiles = this.document.profiles;
            this.document.profiles = profiles.filter(item => item.id !== id);
            delete this.document.maintenance[id];
            try { this.persist(); }
            catch (error) {
                // A failure after atomic rename can still have committed the registry.
                // Read the durable account entry before restoring its in-memory state.
                let saved;
                try { saved = read(this.file); } catch { /* retain the conservative recoverable state */ }
                const durable = saved?.profiles?.find(item => item.id === id);
                if (!saved || durable) {
                    this.document.profiles = profiles;
                    this.document.maintenance[id] = saved?.maintenance?.[id] || transaction;
                }
                throw error;
            }
            this.healths.delete(id); this.states.delete(id); this.retries.delete(id); this.displays.delete(id);
            this.onChange();
            return { id, deleted: true };
        } catch (error) {
            if (this.document.profiles.some(item => item.id === id)) {
                if (this.document.maintenance[id]) this.document.maintenance[id].error = error.code || 'DELETE_FAILED';
                this.states.set(id, 'delete_failed');
                try { this.persist(); } catch { /* the previous durable deletion record remains the recovery authority */ }
                this.onChange();
            }
            throw error;
        }
    }
    writeConfig(id) {
        const item = this.get(id), base = this.location(id);
        for (const name of ['state', 'rpc', 'data', 'logs', 'temp', 'home', 'config', 'runtime', 'cache', 'media']) privateDirectory(this.root, path.join(base, name));
        const file = path.join(base, 'state/config.json');
        const keyFile = path.join(base, 'state/media-key.txt');
        if (!fs.existsSync(keyFile)) atomic(keyFile, crypto.randomBytes(32).toString('hex') + '\n');
        const settings = read(path.join(this.control, 'settings.json'), {});
        atomic(file, { profileId: id, expectedUin: item.expectedUin || item.boundUin || undefined,
            rpcDirectory: path.join(base, 'rpc'), dataDirectory: path.join(base, 'data'), logDirectory: path.join(base, 'logs'),
            healthFile: path.join(base, 'state/health.json'), authorizationFile: path.join(base, 'state/authorization.json'),
            mediaDirectory: path.join(base, 'media'), mediaSigningKeyFile: keyFile,
            ...(settings.publicBaseUrl ? { mediaBaseUrl: settings.publicBaseUrl.replace(/\/$/, '') + '/media/' + id } : {}),
            gatewayPort: 0, actionTimeoutMs: item.actionTimeoutMs, nodes: item.nodes });
        return file;
    }
    async start(id, { automatic = false } = {}) {
        return this.operate(id, () => this.startAccount(id, { automatic }));
    }
    clearRetry(id) {
        clearTimeout(this.retryTimers.get(id)); this.retryTimers.delete(id);
    }
    async startAccount(id, { automatic = false } = {}) {
        const item = this.get(id);
        if (this.closing) throw fail('CLOSING', 'Manager is stopping', 503);
        if (this.persistenceBlocked.has(id)) throw fail('PERSISTENCE_UNAVAILABLE', 'Account registry requires repair before starting', 503);
        if (this.document.maintenance[id]) throw fail('MAINTENANCE', 'Instance is in maintenance', 409);
        const restoreJournal = read(path.join(this.control, 'restore-journal.json'), null);
        if (restoreJournal && (!Array.isArray(restoreJournal.ids) || restoreJournal.ids.includes(id))) throw fail('MAINTENANCE', 'Restore recovery is pending', 409);
        if (this.processes.has(id)) return this.list().find(item => item.id === id);
        if (this.processes.size >= this.maxAccounts) throw fail('ACCOUNT_LIMIT', 'Simultaneous account limit reached', 409);
        const memory = this.memory();
        if (memory.free < 384 * 1024 * 1024 || memory.total < 1024 * 1024 * 1024) throw fail('LOW_MEMORY', 'Insufficient memory to start QQ', 503);
        const uin = item.expectedUin || item.boundUin;
        if (uin && [...this.processes.keys()].some(key => key !== id && (this.get(key).expectedUin || this.get(key).boundUin) === uin)) {
            throw fail('DUPLICATE_ACCOUNT', 'QQ account is already starting or running', 409);
        }
        if (process.platform !== 'linux' && !this.customPlatform) throw fail('PLATFORM', 'QQ instances require Linux x64', 409);
        this.assertStopped(id);
        this.clearRetry(id);
        const previousIntent = item.desired;
        let persistenceWarning;
        try {
            const base = this.location(id), config = this.writeConfig(id);
            this.clearGrant(id);
            const healthFile = path.join(base, 'state/health.json');
            if (fs.existsSync(healthFile)) fs.unlinkSync(healthFile);
            const display = this.allocateDisplay(id);
            // Commit running intent before any process can become ready. A
            // rejected write must never leave an unreported live QQ worker.
            persistenceWarning = this.commitProfile(id, { desired: 'running' });
            const child = this.spawnAccount({ cwd: this.root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, FWD_MANAGER_ROOT: this.root, FWD_ACCOUNT_ROOT: base, FWD_CONFIG: config, FWD_RPC_DIR: path.join(base, 'rpc'),
                    FWD_BRIDGE_ENABLED: item.bridgeInstalled === false ? '0' : '1',
                    FWD_EXPECTED_UIN: item.expectedUin || item.boundUin || '',
                    DISPLAY: display, TEMP: path.join(base, 'temp'), TMP: path.join(base, 'temp'), TMPDIR: path.join(base, 'temp') } });
            child.freshwaterExited = false;
            child.freshwaterDisplay = display; this.displays.set(id, display);
            this.processes.set(id, child);
            // Account scripts log operational codes only. Do not forward native QQ output into the manager stream.
            child.stdout?.resume(); child.stderr?.resume();
            child.once('error', () => this.exit(id, child));
            child.once('exit', () => { child.freshwaterExited = true; this.exit(id, child); });
            if (!automatic) this.retries.delete(id);
            this.states.set(id, item.bridgeInstalled === false ? 'qq_only' : 'starting'); this.onChange();
            return { ...this.list().find(item => item.id === id), ...(persistenceWarning ? { persistenceWarning } : {}) };
        } catch (error) {
            this.clearGrant(id);
            if (this.get(id).desired !== previousIntent) {
                try { this.commitProfile(id, { desired: previousIntent }); }
                catch { this.persistenceBlocked.add(id); this.states.set(id, 'persistence_failed'); }
            }
            if (this.processes.has(id)) await this.stopAccount(id, { preserveIntent: true }).catch(() => {});
            throw error;
        }
    }
    clearGrant(id) {
        const file = path.join(this.location(id), 'state/authorization.json');
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    assertStopped(id) { ownership.assertStopped(this.location(id)); }
    exit(id, child) {
        if (this.processes.get(id) !== child) return;
        if (!this.stopping.has(id)) this.processes.delete(id);
        if (!this.stopping.has(id)) {
            try { this.assertStopped(id); this.displays.delete(id); } catch { /* reserve a possibly surviving display until ownership recovery */ }
        }
        this.clearGrant(id); this.healths.delete(id);
        const item = this.get(id);
        this.states.set(id, this.document.maintenance[id] ? 'maintenance' : this.stopping.has(id) ? 'stopped' : item.desired === 'running' ? 'error' : 'stopped');
        if (!this.closing && !this.stopping.has(id) && item.desired === 'running' && !this.document.maintenance[id]) {
            const count = (this.retries.get(id) || 0) + 1; this.retries.set(id, count);
            if (count <= 3) {
                const timer = setTimeout(() => {
                    this.retryTimers.delete(id);
                    if (item.desired === 'running' && !this.document.maintenance[id] && !this.closing && !this.busy.has(id)) this.start(id, { automatic: true }).catch(() => {});
                }, Math.min(30000, 1000 * 2 ** count));
                timer.unref();
                this.retryTimers.set(id, timer);
            } else this.states.set(id, 'retry_exhausted');
        }
        this.onChange();
    }
    async stop(id, { preserveIntent = false } = {}) {
        return this.operate(id, () => this.stopAccount(id, { preserveIntent }));
    }
    async stopAccount(id, { preserveIntent = false } = {}) {
        const item = this.get(id);
        this.clearRetry(id);
        if (!preserveIntent) this.commitProfile(id, { desired: 'stopped' });
        this.clearGrant(id);
        const child = this.processes.get(id);
        if (!child) { this.assertStopped(id); this.displays.delete(id); this.healths.delete(id); this.states.set(id, 'stopped'); return; }
        this.stopping.add(id);
        this.states.set(id, 'stopping');
        let exited = child.freshwaterExited === true || child.exitCode !== undefined && child.exitCode !== null;
        const finished = exited ? Promise.resolve() : new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
        try {
        // Revoke first, then allow already-started kernel operations to settle while QQ remains alive.
        // Wait for a fresh worker report, so a report from just before revocation cannot conceal a request.
        const healthFile = path.join(this.location(id), 'state/health.json');
        const revokedAt = Date.now();
        let latest;
        try { latest = read(healthFile, {}); } catch { latest = {}; }
        if (!exited && Object.hasOwn(latest, 'activeActions')) {
            const deadline = revokedAt + 61000;
            while (!exited && Date.now() < deadline) {
                let state;
                try { state = read(healthFile, {}); } catch { state = {}; }
                if (state.at >= revokedAt && state.at <= Date.now() + 5000 && state.activeActions === 0) break;
                if (!Number.isFinite(state.at) || Date.now() - state.at > 15000) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        if (!exited) child.kill('SIGTERM');
        let timer;
        await Promise.race([finished, new Promise(resolve => { timer = setTimeout(resolve, item.actionTimeoutMs + 25000); })]);
        clearTimeout(timer);
        if (!exited && this.processes.has(id)) {
            child.kill('SIGKILL');
            this.states.set(id, 'stop_unconfirmed');
            throw fail('STOP_UNCONFIRMED', 'Instance required forced termination; verify child processes before backup', 503);
        }
        this.assertStopped(id);
        this.processes.delete(id); this.displays.delete(id); this.healths.delete(id); this.onChange();
        } finally { this.stopping.delete(id); }
    }
    async restart(id) { return this.operate(id, async () => { await this.stopAccount(id); return this.startAccount(id); }); }
    poll() {
        const claimed = new Map();
        for (const [id] of this.processes) {
            try { this.pollAccount(id, claimed); }
            catch {
                // Filesystem failure for one account must not keep its old
                // online badge or prevent other accounts from renewing health.
                this.healths.delete(id);
                if (!this.stopping.has(id)) this.states.set(id, 'bridge_unavailable');
                try { this.clearGrant(id); } catch { /* retain unknown state for local repair */ }
            }
        }
        this.onChange();
    }
    pollAccount(id, claimed) {
        if (this.persistenceBlocked.has(id)) { this.clearGrant(id); this.healths.delete(id); this.states.set(id, 'persistence_failed'); return; }
        if (this.get(id).bridgeInstalled === false) {
            this.clearGrant(id); this.healths.delete(id);
            if (!this.stopping.has(id)) this.states.set(id, 'qq_only');
            return;
        }
        const health = read(path.join(this.location(id), 'state/health.json'));
        if (!health || typeof health !== 'object' || Array.isArray(health) || !Number.isFinite(health.at) ||
            Date.now() - health.at > 15000 || health.at > Date.now() + 5000) throw fail('HEALTH_UNAVAILABLE', 'Worker health is unknown', 503);
        this.healths.set(id, health);
        const uin = health.selfId == null ? null : String(health.selfId), epoch = health.sessionEpoch;
        if (!uin || !/^[1-9]\d{0,15}$/.test(uin) || !Number.isSafeInteger(Number(uin)) || health.ready !== true || typeof epoch !== 'string' || !epoch) {
            this.clearGrant(id);
            if (!this.stopping.has(id) && !this.document.maintenance[id]) this.states.set(id, 'starting');
            return;
        }
        const item = this.get(id), expected = item.expectedUin || item.boundUin;
        if (expected && expected !== uin) { this.clearGrant(id); this.states.set(id, 'account_mismatch'); return; }
        if (claimed.has(uin)) { this.clearGrant(id); this.states.set(id, 'duplicate_account'); return; }
        claimed.set(uin, id);
        if (this.document.maintenance[id] || this.closing || item.desired !== 'running' || this.stopping.has(id)) { this.clearGrant(id); return; }
        const authorization = path.join(this.location(id), 'state/authorization.json');
        let old;
        try { old = read(authorization, null); } catch { this.clearGrant(id); old = null; }
        if (!old || old.profileId !== id || old.uin !== uin || old.epoch !== epoch || typeof old.managementToken !== 'string' || old.managementToken.length < 32) atomic(authorization, {
            profileId: id, uin, epoch, managementToken: crypto.randomBytes(32).toString('base64url') });
        if (!item.boundUin) this.commitProfile(id, { boundUin: uin });
        this.states.set(id, health.online === true ? 'online' : health.online === false ? 'offline' : 'online_unknown');
    }
    gateway(id) {
        if (this.get(id).bridgeInstalled === false) throw fail('BRIDGE_UNINSTALLED', 'Install the adapter bridge before using OneBot actions', 409);
        const health = this.healths.get(id);
        if (this.document.maintenance[id] || this.stopping.has(id) || !this.processes.has(id) || !health || !Number.isInteger(health.gatewayPort) ||
            health.gatewayPort < 1 || health.gatewayPort > 65535 || Date.now() - health.at > 15000 || health.at > Date.now() + 5000) throw fail('NOT_READY', 'Account gateway unavailable', 503);
        return health.gatewayPort;
    }
    async action(id, action, params = {}) {
        const port = this.gateway(id), item = this.get(id);
        if (!['online', 'offline', 'online_unknown'].includes(this.states.get(id))) throw fail('NOT_READY', 'Authenticated account is not ready', 503);
        const secret = read(path.join(this.location(id), 'state/authorization.json'));
        const response = await fetch('http://127.0.0.1:' + port + '/internal/action', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret.managementToken },
            body: JSON.stringify({ action, params }), signal: AbortSignal.timeout(Math.max(item.actionTimeoutMs, 60000) + 1000)
        });
        if (!response.ok) throw fail('QUERY_FAILED', 'Worker action gateway rejected request', 503);
        return response.json();
    }
    async maintain(ids, operation) {
        for (const id of ids) { this.get(id); if (this.document.maintenance[id] || this.busy.has(id)) throw fail('BUSY', 'Account is busy', 409); }
        const previous = {};
        for (const id of ids) {
            previous[id] = this.get(id).desired;
            this.document.maintenance[id] = { operation, phase: 'stopping', previous: previous[id], at: Date.now() };
        }
        this.persist();
        for (const id of ids) await this.stopAccount(id, { preserveIntent: true });
        for (const id of ids) this.document.maintenance[id].phase = 'stopped';
        this.persist(); return previous;
    }
    async finishMaintenance(ids, { success, resume = false } = {}) {
        for (const id of ids) {
            const transaction = this.document.maintenance[id];
            if (!success) { if (transaction) transaction.phase = 'failed'; this.states.set(id, 'maintenance_failed'); continue; }
            delete this.document.maintenance[id];
            if (!resume) this.get(id).desired = 'stopped';
        }
        this.persist();
        if (success && resume) for (const id of ids) if (this.get(id).desired === 'running') await this.start(id, { automatic: true });
        this.onChange();
    }
    async recoverMaintenance(id) {
        this.get(id);
        if (this.processes.has(id) || this.busy.has(id)) throw fail('BUSY', 'Account is still running or changing state', 409);
        this.busy.add(id);
        try {
        if (this.document.maintenance[id]?.operation === 'delete') return await this.completeRemoval(id, this.document.maintenance[id]);
        this.clearGrant(id); this.clearRetry(id);
        await ownership.recover(this.location(id));
        this.assertStopped(id);
        delete this.document.maintenance[id]; this.get(id).desired = 'stopped'; this.persist(); this.states.set(id, 'stopped');
        } finally { this.busy.delete(id); }
    }
    async initialize() {
        this.timer = setInterval(() => { try { this.poll(); } catch { /* keep manager available for repair */ } }, 500);
        this.timer.unref();
        for (const item of this.document.profiles) if (item.desired === 'running' && !this.document.maintenance[item.id]) {
            try { await this.start(item.id, { automatic: true }); } catch { this.states.set(item.id, 'start_failed'); }
        }
    }
    async close() {
        this.closing = true; clearInterval(this.timer);
        for (const id of this.retryTimers.keys()) this.clearRetry(id);
        await Promise.allSettled([...this.operations.values()]);
        await Promise.allSettled([...this.processes.keys()].map(id => this.stopAccount(id, { preserveIntent: true })));
    }
}
module.exports = { Accounts, profile, nodes, sanitize, memoryAvailable, notificationSelection };
