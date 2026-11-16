'use strict';

// This private journal records only IDs returned by our own create operation.
// It is never an input parameter, public action, cache of shared files or log.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const media = require('./media.cjs'), fixed = require('./flash-transfer-protocol.cjs');
const STAGES = new Set(['allocated', 'committed', 'complete', 'registered', 'uploaded', 'ready', 'confirmed', 'cleanup_pending']);
const MAX_RECORDS = 1000, MAX_BYTES = 256 * 1024;
const reservations = new Map();
function fail(message) { throw Object.assign(new Error(message), { code: 'INVALID_CONFIG' }); }
function ordinary(info) {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) fail('Flash recovery journal must be private and owned by this account');
}
function createFlashRecovery(root, selfUin, selfUid) {
    selfUin = String(fixed.integer(selfUin, 0xffffffffn, true)); fixed.uid(selfUid);
    const directory = media.privateRoot(root), filename = path.join(directory, 'fwd-flash-recovery.json');
    function checkRoot() { if (media.privateRoot(root) !== directory) fail('Flash recovery account directory changed'); }
    function read() {
        checkRoot(); let fd, opened;
        try { opened = fs.lstatSync(filename); ordinary(opened); fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
        catch (error) { if (error.code === 'ENOENT') return { version: 1, selfUin, selfUid, filesets: [] }; throw error; }
        let bytes;
        try {
            const before = fs.fstatSync(fd); ordinary(before);
            if (opened.dev !== before.dev || opened.ino !== before.ino) fail('Flash recovery journal changed before its read');
            if (before.size > MAX_BYTES) fail('Flash recovery journal exceeds its byte budget');
            const bounded = Buffer.alloc(before.size + 1); let length = 0;
            while (length < bounded.length) { const count = fs.readSync(fd, bounded, length, bounded.length - length, length); if (!count) break; length += count; }
            bytes = bounded.subarray(0, length); const after = fs.fstatSync(fd);
            if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('Flash recovery journal changed during its read');
            const linked = fs.lstatSync(filename); ordinary(linked);
            if (linked.dev !== after.dev || linked.ino !== after.ino) fail('Flash recovery journal was replaced during its read');
        } finally { fs.closeSync(fd); }
        let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('Invalid flash recovery journal'); }
        if (!fixed.object(value) || Object.keys(value).some(key => !['version', 'selfUin', 'selfUid', 'filesets'].includes(key)) || value.version !== 1 || value.selfUin !== selfUin || value.selfUid !== selfUid || !Array.isArray(value.filesets) || value.filesets.length > MAX_RECORDS) fail('Flash recovery journal belongs to another account or has an invalid schema');
        const seen = new Set();
        for (const row of value.filesets) {
            if (!fixed.object(row) || Object.keys(row).some(key => !['filesetId', 'stage', 'lastStage', 'createdAt', 'updatedAt'].includes(key))) fail('Invalid flash recovery record');
            try { fixed.uuid(row.filesetId); } catch { fail('Invalid flash recovery identity'); }
            if (seen.has(row.filesetId) || !STAGES.has(row.stage) || (row.stage === 'cleanup_pending' ? !STAGES.has(row.lastStage) || row.lastStage === 'cleanup_pending' : row.lastStage !== undefined) || !Number.isSafeInteger(row.createdAt) || row.createdAt < 1 || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < row.createdAt) fail('Invalid flash recovery stage');
            seen.add(row.filesetId);
        }
        return value;
    }
    function write(value) {
        checkRoot(); const bytes = Buffer.from(JSON.stringify(value) + '\n'); if (bytes.length > MAX_BYTES) fail('Flash recovery journal exceeds its byte budget');
        const temp = path.join(directory, '.fwd-flash-recovery-' + crypto.randomBytes(12).toString('hex') + '.tmp');
        let fd;
        try {
            fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600); ordinary(fs.fstatSync(fd));
            fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
            try { ordinary(fs.lstatSync(filename)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            fs.renameSync(temp, filename);
            if (process.platform !== 'win32') { const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); } }
        } finally {
            if (fd !== undefined) fs.closeSync(fd);
            try { ordinary(fs.lstatSync(temp)); fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
    return {
        prepare() {
            const value = read(), key = JSON.stringify([directory, selfUin, selfUid]), count = reservations.get(key) || 0;
            if (value.filesets.length + count >= MAX_RECORDS) throw Object.assign(new Error('Flash recovery journal is full; clean existing owned filesets first'), { code: 'BUSY' });
            write(value); reservations.set(key, count + 1); let released = false;
            return () => { if (released) return; released = true; const remaining = (reservations.get(key) || 1) - 1; if (remaining) reservations.set(key, remaining); else reservations.delete(key); };
        },
        has(id) { fixed.uuid(id); return read().filesets.some(row => row.filesetId === id); },
        list() { return read().filesets.map(row => ({ ...row })); },
        allocated(id) {
            fixed.uuid(id); const value = read(); if (value.filesets.some(row => row.filesetId === id)) fail('QQ returned an already tracked allocation identity');
            if (value.filesets.length >= MAX_RECORDS) throw Object.assign(new Error('Flash recovery journal is full'), { code: 'BUSY' });
            const now = Date.now(); value.filesets.push({ filesetId: id, stage: 'allocated', createdAt: now, updatedAt: now }); write(value);
        },
        stage(id, stage) {
            fixed.uuid(id); if (!STAGES.has(stage)) fail('Unknown flash recovery stage'); const value = read(), row = value.filesets.find(row => row.filesetId === id);
            if (!row) fail('Cannot modify an unallocated flash recovery identity');
            if (stage === 'cleanup_pending' && row.stage !== 'cleanup_pending') row.lastStage = row.stage;
            else if (stage !== 'cleanup_pending') delete row.lastStage;
            row.stage = stage; row.updatedAt = Math.max(Date.now(), row.createdAt, row.updatedAt); write(value);
        },
        deleted(id) { fixed.uuid(id); const value = read(), index = value.filesets.findIndex(row => row.filesetId === id); if (index < 0) return; value.filesets.splice(index, 1); write(value); }
    };
}
module.exports = { createFlashRecovery, STAGES, MAX_RECORDS, MAX_BYTES };
