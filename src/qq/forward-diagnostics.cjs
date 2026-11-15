'use strict';

// Opt-in evidence for the private native merge experiment. No request may
// choose a path, and nothing written here is an IPC event or operational log.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_RUNS = 8;
const MAX_ENTRIES = 64;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_RUN_BYTES = 2 * 1024 * 1024;
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function fail(message) { throw problem('INVALID_CONFIG', message); }
function noLinks(target) {
    let current = path.parse(target).root;
    for (const part of path.relative(current, target).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) fail('Native merge diagnostic paths cannot contain links');
    }
    return target;
}
function ownedDirectory(target, create = false) {
    if (create) {
        noLinks(path.dirname(target));
        try { fs.mkdirSync(target, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    noLinks(target);
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || (process.platform !== 'win32' &&
        (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
        fail('Native merge diagnostics require private owned directories');
    }
    return target;
}
function protectedAncestor(target) {
    noLinks(target);
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || process.platform !== 'win32' &&
        (![0, process.getuid()].includes(stat.uid) || (stat.mode & 0o022) !== 0)) {
        fail('Native merge diagnostic parents cannot be writable by other users');
    }
}
function directory(environment, selfUin) {
    const root = environment?.FWD_MANAGER_ROOT, account = environment?.FWD_ACCOUNT_ROOT;
    if (typeof root !== 'string' || typeof account !== 'string' || !path.isAbsolute(root) || !path.isAbsolute(account) ||
        path.resolve(root) !== root || path.resolve(account) !== account) {
        fail('Native merge diagnostics require a managed account workspace');
    }
    const profile = path.basename(account);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile) ||
        account !== path.join(root, 'work', 'accounts', profile) ||
        environment.FWD_RPC_DIR !== path.join(account, 'rpc') ||
        environment.FWD_EXPECTED_UIN && environment.FWD_EXPECTED_UIN !== selfUin) {
        fail('Native merge diagnostic account ownership does not match');
    }
    for (const ancestor of [root, path.join(root, 'work'), path.join(root, 'work/accounts')]) protectedAncestor(ancestor);
    ownedDirectory(account);
    const state = ownedDirectory(path.join(account, 'state'), true);
    return ownedDirectory(path.join(state, 'native-forward-diagnostics'), true);
}
function snapshot(value) {
    let budget = MAX_ENTRY_BYTES, nodes = 0;
    const seen = new Set();
    const clone = (item, depth) => {
        if (++nodes > 8192 || depth > 16) throw problem('DIAGNOSTIC_LIMIT', 'Native merge evidence exceeds its bounds');
        if (item === null || typeof item === 'boolean') return item;
        if (typeof item === 'string') {
            budget -= Buffer.byteLength(item);
            if (budget < 0) throw problem('DIAGNOSTIC_LIMIT', 'Native merge evidence exceeds its bounds');
            return item;
        }
        if (typeof item === 'number') {
            if (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item)) {
                throw problem('DIAGNOSTIC_UNREPRESENTABLE', 'Native merge evidence contains an inexact number');
            }
            return item;
        }
        if (typeof item === 'undefined') return { $type: 'undefined' };
        if (typeof item === 'bigint') {
            const value = String(item); budget -= Buffer.byteLength(value);
            if (budget < 0) throw problem('DIAGNOSTIC_LIMIT', 'Native merge evidence exceeds its bounds');
            return { $type: 'bigint', value };
        }
        if (typeof item !== 'object') return { $type: typeof item };
        if (seen.has(item)) throw problem('DIAGNOSTIC_UNREPRESENTABLE', 'Native merge evidence is cyclic');
        seen.add(item);
        try {
            // Sparse arrays can have very few keys but billions of positions.
            // Bound length before constructing an output or JSON encoding it.
            if (Array.isArray(item) && item.length > 4096) {
                throw problem('DIAGNOSTIC_LIMIT', 'Native merge evidence exceeds its bounds');
            }
            if (item instanceof Map) {
                const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(item);
                if (size > 4096) throw problem('DIAGNOSTIC_LIMIT', 'Native merge evidence exceeds its bounds');
                const entries = [];
                for (const [key, value] of Map.prototype.entries.call(item)) {
                    entries.push([clone(key, depth + 1), clone(value, depth + 1)]);
                }
                return { $type: 'map', entries };
            }
            const keys = Object.keys(item);
            if (keys.length > 4096) throw problem('DIAGNOSTIC_LIMIT', 'Native merge evidence exceeds its bounds');
            const output = Array.isArray(item) ? [] : Object.create(null);
            for (const key of keys) {
                const descriptor = Object.getOwnPropertyDescriptor(item, key);
                if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
                    throw problem('DIAGNOSTIC_UNREPRESENTABLE', 'Native merge evidence contains an accessor');
                }
                budget -= Buffer.byteLength(key);
                if (budget < 0) throw problem('DIAGNOSTIC_LIMIT', 'Native merge evidence exceeds its bounds');
                Object.defineProperty(output, key, { value: clone(descriptor.value, depth + 1), enumerable: true });
            }
            return output;
        } finally { seen.delete(item); }
    };
    return clone(value, 0);
}
function nativeError(error) {
    const result = {};
    for (const key of ['name', 'code', 'message']) {
        const descriptor = error && Object.getOwnPropertyDescriptor(error, key);
        if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string') {
            result[key] = descriptor.value.slice(0, 16384);
        }
    }
    return result;
}
function writeAll(fd, text) {
    const buffer = Buffer.from(text);
    for (let offset = 0; offset < buffer.length;) {
        const count = fs.writeSync(fd, buffer, offset, buffer.length - offset);
        if (!Number.isSafeInteger(count) || count <= 0 || count > buffer.length - offset) {
            throw problem('DIAGNOSTIC_FAILED', 'Native merge evidence could not be fully written');
        }
        offset += count;
    }
}
function beginForwardDiagnostic({ environment, state, source, sourceMsgIds, correlation, now = Date.now }) {
    let base;
    try { base = directory(environment, state.uin); }
    catch { throw problem('INVALID_CONFIG', 'Native merge diagnostics require a private managed account workspace'); }
    // Evidence is never silently rotated or removed. An operator must preserve
    // or explicitly remove old runs before opting into another bounded run.
    if (fs.readdirSync(base).length >= MAX_RUNS) throw problem('BUSY', 'Native merge diagnostic run limit was reached');
    const id = randomUUID(), target = ownedDirectory(path.join(base, id), true);
    const identity = fs.lstatSync(target);
    function originalDirectory() {
        ownedDirectory(target);
        const current = fs.lstatSync(target);
        if (current.dev !== identity.dev || current.ino !== identity.ino) fail('Native merge diagnostic run directory changed');
    }
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
    const file = path.join(target, 'records.jsonl');
    const fd = fs.openSync(file, flags, 0o600);
    let closed = false, entries = 0, bytes = 0, dropped = 0, nativeObserved = false, lateWritten = false;
    function encode(phase, data) {
        const text = JSON.stringify({ at: now(), phase, data: snapshot(data) }) + '\n';
        if (Buffer.byteLength(text) > MAX_ENTRY_BYTES) throw problem('DIAGNOSTIC_LIMIT', 'Native merge evidence exceeds its bounds');
        return text;
    }
    function record(phase, data) {
        if (closed) return false;
        if (entries >= MAX_ENTRIES || bytes >= MAX_RUN_BYTES) { dropped++; return false; }
        try {
            const text = encode(phase, data), size = Buffer.byteLength(text);
            if (entries >= MAX_ENTRIES || bytes + size > MAX_RUN_BYTES) { dropped++; return false; }
            writeAll(fd, text);
            entries++; bytes += size;
            return true;
        } catch { dropped++; return false; }
    }
    function nativeResult(value, rejected = false) {
        if (nativeObserved) return;
        nativeObserved = true;
        // A native Promise may settle after the RPC deadline. Retain its one
        // result in this old run without keeping callback observers alive or
        // changing the already-returned timeout into a success.
        try {
            const data = rejected ? nativeError(value) : value;
            if (!closed) { record(rejected ? 'native-rejected' : 'native-result', data); return; }
            if (lateWritten) return;
            lateWritten = true;
            originalDirectory();
            const text = encode(rejected ? 'native-rejected-after-close' : 'native-result-after-close', data);
            const late = fs.openSync(path.join(target, 'native-late-result.json'), flags, 0o600);
            try { writeAll(late, text); fs.fsyncSync(late); }
            finally { fs.closeSync(late); }
        } catch { dropped++; /* private evidence loss never changes a completed action */ }
    }
    function close(outcome) {
        if (closed) return;
        record('closed', { ...outcome, nativeObserved, entries, bytes, dropped });
        closed = true;
        try { fs.fsyncSync(fd); } catch { /* preserve the action result */ }
        try { fs.closeSync(fd); } catch { /* do not leak into normal logs */ }
        // This separate small final record remains available even when callback
        // evidence has exhausted its count/byte quota.
        try {
            originalDirectory();
            const summary = fs.openSync(path.join(target, 'summary.json'), flags, 0o600);
            try {
                writeAll(summary, encode('summary', { ...outcome, nativeObserved, entries, bytes, dropped }));
                fs.fsyncSync(summary);
            } finally { fs.closeSync(summary); }
        } catch { /* private evidence loss never changes a completed action */ }
    }
    if (!record('prepared', { schemaVersion: 1, id, epoch: state.epoch, selfUin: state.uin, selfUid: state.uid,
        source, sourceMsgIds, correlation, sendsAllowed: 1 })) {
        close({ dispatched: false, code: 'DIAGNOSTIC_FAILED' });
        throw problem('DIAGNOSTIC_FAILED', 'Native merge diagnostic preparation failed before submission');
    }
    try { fs.fsyncSync(fd); }
    catch {
        close({ dispatched: false, code: 'DIAGNOSTIC_FAILED' });
        throw problem('DIAGNOSTIC_FAILED', 'Native merge diagnostic preparation failed before submission');
    }
    return { id, record, nativeResult, close };
}

module.exports = { beginForwardDiagnostic };
