'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function problem(code, message) { return Object.assign(new Error(message), { code }); }
function accountKey(account) {
    const value = String(account || '');
    if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw problem('INVALID_REQUEST', 'A real account UIN is required');
    }
    return value;
}
function snapshot(value) {
    try {
        return JSON.parse(JSON.stringify(value, (_key, item) => {
            if (typeof item === 'bigint') return item.toString();
            if (item instanceof Map) return Object.fromEntries(item);
            if (typeof item === 'number' && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) {
                throw problem('INVALID_RESPONSE', 'QQ message contains an inexact number');
            }
            return item;
        }));
    } catch { throw problem('INVALID_RESPONSE', 'QQ message cannot be saved without losing data'); }
}
function locator(record) {
    const chatType = Number(record.chatType);
    const peerUid = String(record.peerUid || '');
    const nativeId = String(record.msgId || '');
    if (![1, 2].includes(chatType) || !peerUid || !nativeId ||
        ['msgId', 'msgSeq', 'clientSeq', 'msgTime'].some(key => typeof record[key] === 'number' && !Number.isSafeInteger(record[key]))) {
        throw problem('INVALID_RESPONSE', 'QQ message has no complete native identity');
    }
    return { peer: { chatType, peerUid }, nativeId,
        seq: String(record.msgSeq || ''), clientSeq: String(record.clientSeq || ''),
        senderUin: String(record.senderUin || ''), senderUid: String(record.senderUid || ''),
        time: String(record.msgTime || '') };
}
function identity(value) { return JSON.stringify([value.peer.chatType, value.peer.peerUid, value.nativeId]); }
function replaceEntry(state, entry) {
    state.byId.set(entry.id, entry);
    state.byNative.set(identity(entry.locator), entry);
    return entry;
}
const WAL_LIMIT = 4 * 1024 * 1024;
function syncDirectory(directory) {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function validateEntry(entry, nextId) {
    return Number.isInteger(entry?.id) && entry.id >= 1 && entry.id < nextId &&
        entry.locator?.peer && [1, 2].includes(entry.locator.peer.chatType) &&
        typeof entry.locator.peer.peerUid === 'string' && entry.locator.peer.peerUid &&
        typeof entry.locator.nativeId === 'string' && entry.locator.nativeId;
}
function checksum(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

class MessageStore {
    constructor({ directory, maxMessages = 10000, readOnly = false } = {}) {
        if (!directory || !path.isAbsolute(directory)) throw problem('INVALID_CONFIG', 'Message store directory must be absolute');
        if (!Number.isInteger(maxMessages) || maxMessages < 1) throw problem('INVALID_CONFIG', 'Invalid message cache size');
        this.directory = directory;
        this.maxMessages = maxMessages;
        this.readOnly = readOnly === true;
        this.accounts = new Map();
        this.poisoned = new Set();
        if (!this.readOnly) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }

    state(account) {
        const key = accountKey(account);
        if (this.poisoned.has(key)) throw problem('INVALID_STORE', 'Message persistence outcome is unknown; restart before using this account');
        if (this.accounts.has(key)) return this.accounts.get(key);
        const state = { account: key, nextId: 1, revision: 0, walBytes: 0, byId: new Map(), byNative: new Map(), recent: [] };
        const file = path.join(this.directory, key + '.json');
        if (fs.existsSync(file)) {
            let saved;
            try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
            catch { throw problem('INVALID_STORE', 'Cannot read message ID store; refusing to reuse IDs'); }
            if (saved.version !== 1 || saved.account !== key || !Number.isInteger(saved.nextId) ||
                saved.nextId < 1 || saved.nextId > 0x80000000 || !Array.isArray(saved.entries)) {
                throw problem('INVALID_STORE', 'Invalid message ID store');
            }
            state.nextId = saved.nextId;
            if (saved.revision !== undefined && (!Number.isSafeInteger(saved.revision) || saved.revision < 0)) throw problem('INVALID_STORE', 'Invalid message store revision');
            state.revision = saved.revision || 0;
            for (const entry of saved.entries) {
                if (!validateEntry(entry, state.nextId) ||
                    state.byId.has(entry.id) || state.byNative.has(identity(entry.locator))) {
                    throw problem('INVALID_STORE', 'Conflicting message ID store');
                }
                state.byId.set(entry.id, entry);
                state.byNative.set(identity(entry.locator), entry);
                if (entry.record) state.recent.push(entry.id);
            }
            if (saved.recent !== undefined) {
                if (!Array.isArray(saved.recent) || new Set(saved.recent).size !== saved.recent.length ||
                    saved.recent.length !== state.recent.length || saved.recent.some(id => !state.byId.get(id)?.record)) throw problem('INVALID_STORE', 'Invalid message cache order');
                state.recent = saved.recent;
            }
        } else if (fs.existsSync(file + '.wal') && fs.statSync(file + '.wal').size) {
            throw problem('INVALID_STORE', 'Message journal has no base snapshot; refusing to reuse IDs');
        }
        this.replay(state);
        this.prune(state);
        this.accounts.set(key, state);
        return state;
    }

    prune(state) {
        const changes = [];
        while (state.recent.length > this.maxMessages) {
            const previous = state.byId.get(state.recent.shift());
            if (previous) {
                const item = { ...previous };
                delete item.record; delete item.event;
                replaceEntry(state, item);
                changes.push(item);
            }
        }
        return changes;
    }

    replay(state) {
        const file = path.join(this.directory, state.account + '.json.wal');
        if (!fs.existsSync(file)) return;
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw problem('INVALID_STORE', 'Invalid message journal');
        const bytes = fs.readFileSync(file);
        const complete = bytes.lastIndexOf(10) + 1;
        let previousRevision = -1;
        for (const line of bytes.subarray(0, complete).toString('utf8').split('\n')) {
            if (!line) continue;
            const split = line.lastIndexOf('\t'), text = line.slice(0, split);
            if (split < 0 || checksum(text) !== line.slice(split + 1)) throw problem('INVALID_STORE', 'Message journal checksum mismatch');
            let item;
            try { item = JSON.parse(text); } catch { throw problem('INVALID_STORE', 'Invalid message journal record'); }
            if (item.version !== 1 || item.account !== state.account || !Number.isSafeInteger(item.revision) || item.revision < 1 ||
                item.revision <= previousRevision || !Number.isInteger(item.nextId) || item.nextId < 1 || item.nextId > 0x80000000 ||
                !Array.isArray(item.entries) || !item.entries.length || !Array.isArray(item.touch)) throw problem('INVALID_STORE', 'Invalid message journal transaction');
            previousRevision = item.revision;
            if (item.revision <= state.revision) continue; // Snapshot rename may precede old-journal cleanup.
            if (item.revision !== state.revision + 1 || item.nextId < state.nextId) throw problem('INVALID_STORE', 'Message journal sequence gap');
            const seen = new Set();
            for (const entry of item.entries) {
                const old = state.byId.get(entry?.id), native = validateEntry(entry, item.nextId) && identity(entry.locator);
                if (!native || seen.has(entry.id) || old && identity(old.locator) !== native ||
                    state.byNative.has(native) && state.byNative.get(native).id !== entry.id) throw problem('INVALID_STORE', 'Conflicting message journal entry');
                seen.add(entry.id); replaceEntry(state, entry);
            }
            for (const id of item.touch) {
                if (!Number.isInteger(id) || !state.byId.get(id)?.record) throw problem('INVALID_STORE', 'Invalid message journal cache update');
                state.recent = state.recent.filter(value => value !== id); state.recent.push(id);
            }
            state.recent = state.recent.filter(id => state.byId.get(id)?.record);
            state.nextId = item.nextId; state.revision = item.revision;
        }
        if (complete !== bytes.length && !this.readOnly) {
            // An uncommitted torn suffix cannot allocate an ID. Remove it before appending.
            const fd = fs.openSync(file, 'r+');
            try { fs.ftruncateSync(fd, complete); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
        state.walBytes = complete;
    }

    checkpoint(state, changes = []) {
        if (this.readOnly) throw problem('READ_ONLY', 'This message store is a read-only snapshot');
        if (this.poisoned.has(state.account)) throw problem('INVALID_STORE', 'Message persistence outcome is unknown; preserve disk state for recovery');
        const target = path.join(this.directory, state.account + '.json');
        const temporary = target + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
        try {
            const entries = changes.length ? new Map(state.byId) : state.byId;
            for (const entry of changes) entries.set(entry.id, entry);
            const data = JSON.stringify({ version: 1, account: state.account, revision: state.revision,
                nextId: state.nextId, recent: state.recent, entries: [...entries.values()] });
            const fd = fs.openSync(temporary, 'wx', 0o600);
            try { fs.writeFileSync(fd, data, 'utf8'); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            fs.renameSync(temporary, target);
            syncDirectory(this.directory);
            const journal = target + '.wal';
            if (fs.existsSync(journal)) { fs.unlinkSync(journal); syncDirectory(this.directory); }
            state.walBytes = 0;
        } finally {
            try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }

    persist(state, delta) {
        if (this.readOnly) throw problem('READ_ONLY', 'This message store is a read-only snapshot');
        try {
            const file = path.join(this.directory, state.account + '.json');
            if (!delta || !fs.existsSync(file)) { this.checkpoint(state, delta?.entries); return; }
            if ((delta.previous.walBytes || 0) >= WAL_LIMIT) this.checkpoint(delta.previous);
            const text = JSON.stringify({ version: 1, account: state.account, revision: state.revision,
                nextId: state.nextId, entries: delta.entries, touch: delta.touch });
            const bytes = Buffer.from(text + '\t' + checksum(text) + '\n');
            const journal = file + '.wal', existed = fs.existsSync(journal);
            const fd = fs.openSync(journal, 'a', 0o600);
            try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            if (!existed) syncDirectory(this.directory);
            state.walBytes = (delta.previous.walBytes || 0) + bytes.length;
        } catch (error) { this.poisoned.add(state.account); throw error; }
    }

    update(current, entries, { nextId = current.nextId, touch = [] } = {}) {
        const recent = current.recent.filter(id => !touch.includes(id)); recent.push(...touch);
        const changes = new Map(entries.map(entry => [entry.id, entry]));
        while (recent.length > this.maxMessages) {
            const previous = changes.get(recent[0]) || current.byId.get(recent[0]); recent.shift();
            if (previous) { const item = { ...previous }; delete item.record; delete item.event; changes.set(item.id, item); }
        }
        const state = { ...current, nextId, recent, revision: current.revision + 1 };
        this.persist(state, { entries: [...changes.values()], touch, previous: current });
        for (const entry of changes.values()) replaceEntry(state, entry);
        this.accounts.set(state.account, state);
        return state;
    }

    remember(account, record) {
        const current = this.state(account);
        const where = locator(record);
        // Validate and copy before allocating an ID or replacing an existing
        // message. Rejected native data must leave the mapping unchanged.
        const copy = snapshot(record);
        let entry = current.byNative.get(identity(where));
        let nextId = current.nextId;
        if (!entry) {
            if (nextId > 0x7fffffff) throw problem('ID_EXHAUSTED', 'OneBot message ID space is exhausted');
            entry = { id: nextId++, locator: where, emitted: false };
        }
        entry = { ...entry, locator: where, record: copy };
        this.update(current, [entry], { nextId, touch: [entry.id] });
        return entry;
    }

    stage(account) {
        const current = this.state(account), key = current.account;
        const before = current.revision;
        const entries = snapshot([...current.byId.values()]);
        const draft = { account: key, nextId: current.nextId, revision: current.revision, recent: [...current.recent],
            byId: new Map(entries.map(entry => [entry.id, entry])),
            byNative: new Map(entries.map(entry => [identity(entry.locator), entry])) };
        const staged = Object.create(MessageStore.prototype);
        staged.directory = this.directory; staged.maxMessages = this.maxMessages;
        staged.accounts = new Map([[key, draft]]);
        staged.poisoned = new Set();
        staged.state = value => {
            if (accountKey(value) !== key) throw problem('INVALID_REQUEST', 'Message transaction crossed an account boundary');
            return staged.accounts.get(key);
        };
        staged.persist = () => {};
        let committed = false;
        return { store: staged, commit: () => {
            if (committed) throw problem('INVALID_REQUEST', 'Message transaction is already committed');
            if (this.accounts.get(key) !== current || current.revision !== before) {
                throw problem('BUSY', 'Message history changed during conversion; query again');
            }
            // Publish neither IDs nor cache entries until the atomic file write succeeds.
            const next = { ...staged.state(key), revision: current.revision + 1 };
            this.persist(next);
            this.accounts.set(key, next);
            committed = true;
        } };
    }

    get(account, id) { return this.state(account).byId.get(Number(id)) || null; }

    findPrivateFile(account, { fileId, peerUid, fileHash = '' } = {}) {
        const state = this.state(account), matches = [];
        const fileUrl = require('../qq/private-file-url.cjs');
        for (const id of state.recent) {
            const entry = state.byId.get(id), record = entry?.record;
            if (!record || entry.recalled || Number(record.chatType) !== 1 ||
                peerUid !== undefined && record.peerUid !== peerUid) continue;
            for (const element of record.elements || []) {
                if (element?.elementType !== 3 || element.fileElement?.fileUuid !== fileId) continue;
                let file;
                try { file = fileUrl.fromFileElement(element.fileElement); }
                catch { throw problem('INVALID_RESPONSE', 'Known private file metadata is incomplete'); }
                // An incomplete candidate cannot disappear and make another
                // record look unique, even when an optional hash was supplied.
                if (typeof element.elementId !== 'string' || !element.elementId) {
                    throw problem('INVALID_RESPONSE', 'Known private file has no exact element identity');
                }
                if (fileHash && file.fileHash !== fileHash) continue;
                const where = locator(record);
                if (where.peer.chatType !== entry.locator.peer.chatType || where.peer.peerUid !== entry.locator.peer.peerUid ||
                    where.nativeId !== entry.locator.nativeId) throw problem('INVALID_RESPONSE', 'Known private file message identity changed');
                matches.push({ messageId: entry.id, locator: where, elementId: element.elementId, ...file });
                if (matches.length > 1) throw problem('INVALID_REQUEST', 'Private file selector is ambiguous; specify message_id, user_id or file_hash');
            }
        }
        if (!matches.length) throw problem('NOT_FOUND', 'Private file is outside the retained account history');
        return snapshot(matches[0]);
    }

    find(account, { peer, nativeId, seq, clientSeq, senderUin, senderUid, time } = {}) {
        if (!peer || (!nativeId && (!seq || seq === '0') && !clientSeq)) return null;
        const state = this.state(account);
        const exact = nativeId ? state.byNative.get(identity({ peer, nativeId: String(nativeId) })) : null;
        const entries = nativeId ? exact ? [exact] : [] : [...state.byId.values()];
        const candidates = entries.filter(entry => {
            const item = entry.locator;
            return item.peer.chatType === peer.chatType && item.peer.peerUid === peer.peerUid &&
                (!nativeId || item.nativeId === String(nativeId)) &&
                (!seq || seq === '0' || item.seq === String(seq)) &&
                (!clientSeq || item.clientSeq === String(clientSeq)) &&
                (!senderUin || item.senderUin === String(senderUin)) &&
                (!senderUid || (item.senderUid || entry.record?.senderUid) === senderUid) &&
                (!time || String(item.time || entry.record?.msgTime || '') === String(time));
        });
        return candidates.length === 1 ? candidates[0] : null;
    }

    setEvent(account, id, event, emitted = false) {
        const current = this.state(account), previous = current.byId.get(Number(id));
        if (!previous) throw problem('NOT_FOUND', 'Unknown message ID');
        const converted = snapshot(event);
        const entry = { ...previous, event: converted, emitted: emitted || previous.emitted };
        this.update(current, [entry]);
        return entry;
    }

    setRecalled(account, id, event, emitted = false) {
        const current = this.state(account), previous = current.byId.get(Number(id));
        if (!previous) throw problem('NOT_FOUND', 'Unknown recalled message ID');
        const converted = event ? snapshot(event) : undefined;
        const entry = { ...previous, recalled: true,
            ...(event ? { recallEvent: converted } : {}), ...(emitted ? { recallEmitted: true } : {}) };
        this.update(current, [entry]);
        return entry;
    }

    flush() {
        if (this.readOnly) return;
        // A write may have reached disk before fsync failed. Its older in-memory
        // state must never overwrite that transaction during shutdown.
        if (this.poisoned.size) throw problem('INVALID_STORE', 'Message persistence outcome is unknown; preserve disk state for recovery');
        for (const state of this.accounts.values()) this.persist(state);
    }
    close() { this.flush(); }
}

// Caller must establish that every writer has stopped (manager backup/maintenance).
function checkpointDirectory(directory) {
    if (!fs.existsSync(directory)) return;
    const store = new MessageStore({ directory });
    const accounts = new Set(fs.readdirSync(directory).map(name => /^([1-9]\d{0,15})\.json(?:\.wal)?$/.exec(name)?.[1]).filter(Boolean));
    for (const account of accounts) store.state(account);
    store.close();
}

module.exports = { MessageStore, locator, identity, snapshot, checkpointDirectory };
