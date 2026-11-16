'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fault } = require('../errors.cjs');
const VERSION = 1;
const LIMIT = 2 * 1024 * 1024;
const METHODS = new Set(['status', 'resolve', 'user', 'friends', 'groups', 'groupInfo',
    'groupMember', 'groupMembers', 'history', 'recall', 'prepareMedia', 'prepareMusic', 'prepareShare', 'receiveMedia', 'imageInfo', 'groupAction', 'socialQuery', 'socialAction', 'interaction', 'groupFiles', 'forwardOperation', 'getMessage', 'sendMessage', 'events', 'nativeRkey', 'nativeGroupFileUrl', 'nativeGroupFileSpace', 'nativePrivateFileUrl', 'nativeStatus', 'extendedQuery', 'extendedQuery2', 'shareQuery', 'adminQuery', 'adminAction', 'customFaceQuery', 'customFaceAction', 'contactExtra', 'flashTransfer', 'qzoneQuery', 'qzoneAction', 'voiceExtra', 'forwardUpload', 'friendDressQuery', 'groupAlbumQuery', 'groupAlbumAction', 'miscExtra', 'extendedAction', 'recordExport', 'groupQuery', 'collectionQuery', 'accountQuery']);
const READ_ONLY = new Set(['status', 'resolve', 'user', 'friends', 'groups', 'groupInfo', 'groupMember', 'groupMembers',
    'history', 'imageInfo', 'socialQuery', 'getMessage', 'events', 'nativeRkey', 'nativeGroupFileUrl', 'nativeGroupFileSpace', 'nativePrivateFileUrl', 'nativeStatus', 'extendedQuery', 'extendedQuery2', 'shareQuery', 'adminQuery', 'customFaceQuery', 'qzoneQuery', 'friendDressQuery', 'groupAlbumQuery', 'groupQuery', 'collectionQuery', 'accountQuery']);
function cancellable(method, params) {
    return READ_ONLY.has(method) || method === 'groupFiles' && ['group.filesList', 'group.fileInfo'].includes(params?.operation)
        || method === 'forwardOperation' && params?.kind === 'read'
        || method === 'contactExtra' && ['translate', 'unidirectional', 'doubt.list', 'group.filtered'].includes(params?.operation)
        || method === 'flashTransfer' && ['list', 'detail', 'metadata', 'share', 'download', 'resolve'].includes(params?.operation)
        || method === 'miscExtra' && params?.operation === 'miniapp.ark';
}

function privateDirectory(directory) {
    if (!path.isAbsolute(directory)) throw fault('INVALID_CONFIG', 'RPC directory must be absolute');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fault('INVALID_CONFIG', 'RPC directory must not be a symlink');
    if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())) {
        throw fault('INVALID_CONFIG', 'RPC directory must be owned by this user with mode 0700');
    }
}

function readJson(file) {
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const info = fs.fstatSync(descriptor);
        if (!info.isFile() || info.size > LIMIT) throw fault('INVALID_REQUEST', 'Invalid RPC file or size');
        return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    } finally { fs.closeSync(descriptor); }
}

function writeJson(file, value) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > LIMIT) throw fault('INVALID_RESPONSE', 'RPC response exceeds size limit');
    const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
        fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, file);
    } finally { remove(temporary); }
}

function remove(file) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function processIdentity(pid = process.pid) {
    if (process.platform !== 'linux') return null;
    try {
        const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
        return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + fields[19];
    } catch (_) { return null; }
}

function ownerIsAlive(previous) {
    if (!previous || !Number.isInteger(previous.pid) || previous.pid <= 0) throw fault('BUSY', 'Invalid process ownership metadata');
    try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    const current = processIdentity(previous.pid);
    // Linux PID reuse must not make a stale volume lock permanent after restart.
    if (current && previous.processIdentity && current !== previous.processIdentity) return false;
    return true;
}

function claimOwner(file, metadata) {
    const create = () => {
        const fd = fs.openSync(file, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, processIdentity: processIdentity(), ...metadata })); }
        finally { fs.closeSync(fd); }
    };
    try { create(); return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const recovery = file + '.recovery';
    try { fs.mkdirSync(recovery, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw fault('BUSY', 'Process ownership recovery is already in progress'); throw error; }
    try {
        let previous;
        try { previous = readJson(file); } catch (error) {
            // Exclusive creation becomes visible before the owner finishes its
            // JSON write. An incomplete claim is occupied, never stale proof.
            if (error instanceof SyntaxError) throw fault('BUSY', 'Process ownership metadata is incomplete or needs repair');
            if (error.code !== 'ENOENT') throw error;
        }
        if (previous && ownerIsAlive(previous)) throw fault('BUSY', 'A live process already owns this directory');
        if (previous) remove(file);
        try { create(); } catch (error) {
            if (error.code === 'EEXIST') throw fault('BUSY', 'Another process acquired this directory');
            throw error;
        }
    } finally { fs.rmdirSync(recovery); }
}

module.exports = { VERSION, LIMIT, METHODS, cancellable, privateDirectory, readJson, writeJson, remove, processIdentity, ownerIsAlive, claimOwner };
