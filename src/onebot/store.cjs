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
function draftState(state) {
    return { ...state, byId: new Map(state.byId), byNative: new Map(state.byNative), recent: [...state.recent] };
}
function replaceEntry(state, entry) {
    state.byId.set(entry.id, entry);
    state.byNative.set(identity(entry.locator), entry);
    return entry;
}

class MessageStore {
    constructor({ directory, maxMessages = 10000 } = {}) {
        if (!directory || !path.isAbsolute(directory)) throw problem('INVALID_CONFIG', 'Message store directory must be absolute');
        if (!Number.isInteger(maxMessages) || maxMessages < 1) throw problem('INVALID_CONFIG', 'Invalid message cache size');
        this.directory = directory;
        this.maxMessages = maxMessages;
        this.accounts = new Map();
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }

    state(account) {
        const key = accountKey(account);
        if (this.accounts.has(key)) return this.accounts.get(key);
        const state = { account: key, nextId: 1, byId: new Map(), byNative: new Map(), recent: [] };
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
            for (const entry of saved.entries) {
                if (!Number.isInteger(entry.id) || entry.id < 1 || entry.id >= state.nextId ||
                    !entry.locator || !entry.locator.peer || ![1, 2].includes(entry.locator.peer.chatType) ||
                    typeof entry.locator.peer.peerUid !== 'string' || !entry.locator.peer.peerUid ||
                    typeof entry.locator.nativeId !== 'string' || !entry.locator.nativeId ||
                    state.byId.has(entry.id) || state.byNative.has(identity(entry.locator))) {
                    throw problem('INVALID_STORE', 'Conflicting message ID store');
                }
                state.byId.set(entry.id, entry);
                state.byNative.set(identity(entry.locator), entry);
                if (entry.record) state.recent.push(entry.id);
            }
            this.prune(state);
        }
        this.accounts.set(key, state);
        return state;
    }

    prune(state) {
        while (state.recent.length > this.maxMessages) {
            const previous = state.byId.get(state.recent.shift());
            if (previous) {
                const item = { ...previous };
                delete item.record; delete item.event;
                replaceEntry(state, item);
            }
        }
    }

    persist(state) {
        const target = path.join(this.directory, state.account + '.json');
        const temporary = target + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
        try {
            const data = JSON.stringify({ version: 1, account: state.account,
                nextId: state.nextId, entries: [...state.byId.values()] });
            const fd = fs.openSync(temporary, 'wx', 0o600);
            try { fs.writeFileSync(fd, data, 'utf8'); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            fs.renameSync(temporary, target);
        } finally {
            try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }

    remember(account, record) {
        const current = this.state(account);
        const where = locator(record);
        // Validate and copy before allocating an ID or replacing an existing
        // message. Rejected native data must leave the mapping unchanged.
        const copy = snapshot(record);
        const state = draftState(current);
        let entry = state.byNative.get(identity(where));
        if (!entry) {
            if (state.nextId > 0x7fffffff) throw problem('ID_EXHAUSTED', 'OneBot message ID space is exhausted');
            entry = { id: state.nextId++, locator: where, emitted: false };
        }
        entry = replaceEntry(state, { ...entry, locator: where, record: copy });
        state.recent = state.recent.filter(id => id !== entry.id);
        state.recent.push(entry.id);
        this.prune(state);
        this.persist(state);
        this.accounts.set(state.account, state);
        return entry;
    }

    stage(account) {
        const current = this.state(account), key = current.account;
        const fingerprint = value => JSON.stringify({ nextId: value.nextId,
            entries: [...value.byId.values()], recent: value.recent });
        const before = fingerprint(current);
        const entries = snapshot([...current.byId.values()]);
        const draft = { account: key, nextId: current.nextId, recent: [...current.recent],
            byId: new Map(entries.map(entry => [entry.id, entry])),
            byNative: new Map(entries.map(entry => [identity(entry.locator), entry])) };
        const staged = Object.create(MessageStore.prototype);
        staged.directory = this.directory; staged.maxMessages = this.maxMessages;
        staged.accounts = new Map([[key, draft]]);
        staged.state = value => {
            if (accountKey(value) !== key) throw problem('INVALID_REQUEST', 'Message transaction crossed an account boundary');
            return staged.accounts.get(key);
        };
        staged.persist = () => {};
        let committed = false;
        return { store: staged, commit: () => {
            if (committed) throw problem('INVALID_REQUEST', 'Message transaction is already committed');
            if (this.accounts.get(key) !== current || fingerprint(current) !== before) {
                throw problem('BUSY', 'Message history changed during conversion; query again');
            }
            // Publish neither IDs nor cache entries until the atomic file write succeeds.
            const next = staged.state(key);
            this.persist(next);
            this.accounts.set(key, next);
            committed = true;
        } };
    }

    get(account, id) { return this.state(account).byId.get(Number(id)) || null; }

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
        const converted = snapshot(event), state = draftState(current);
        const entry = replaceEntry(state, { ...previous, event: converted, emitted: emitted || previous.emitted });
        this.persist(state);
        this.accounts.set(state.account, state);
        return entry;
    }

    setRecalled(account, id, event, emitted = false) {
        const current = this.state(account), previous = current.byId.get(Number(id));
        if (!previous) throw problem('NOT_FOUND', 'Unknown recalled message ID');
        const converted = event ? snapshot(event) : undefined, state = draftState(current);
        const entry = replaceEntry(state, { ...previous, recalled: true,
            ...(event ? { recallEvent: converted } : {}), ...(emitted ? { recallEmitted: true } : {}) });
        this.persist(state);
        this.accounts.set(state.account, state);
        return entry;
    }

    flush() { for (const state of this.accounts.values()) this.persist(state); }
    close() { this.flush(); }
}

module.exports = { MessageStore, locator, identity, snapshot };
