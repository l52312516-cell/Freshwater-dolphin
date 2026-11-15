'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { workspacePath } = require('../paths.cjs');

function fail(code, message, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}
function privateDirectory(root, relative) {
    const target = workspacePath(root, relative);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return target;
}
function syncDirectory(directory) {
    // Windows does not expose fsync on directory handles. Linux deployment does.
    if (process.platform === 'win32') return;
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function durableRename(source, target) {
    fs.renameSync(source, target);
    syncDirectory(path.dirname(source));
    if (path.dirname(target) !== path.dirname(source)) syncDirectory(path.dirname(target));
}
function atomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
    try {
        fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
        const descriptor = fs.openSync(temporary, 'r+');
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
        durableRename(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
function identifier(input) {
    if (typeof input !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input)) throw fail('INVALID_ID', 'Invalid instance identifier');
    return input;
}
function expectedUin(input) {
    if (input === undefined || input === null || input === '') return null;
    if (!/^[1-9]\d{0,15}$/.test(String(input)) || !Number.isSafeInteger(Number(input))) throw fail('INVALID_UIN', 'Invalid QQ number');
    return String(input);
}
function equalSecret(a, b) {
    const left = crypto.createHash('sha256').update(String(a)).digest();
    const right = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(left, right);
}
module.exports = { fail, privateDirectory, atomic, read, identifier, expectedUin, equalSecret, syncDirectory, durableRename };
