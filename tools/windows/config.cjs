'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function decodeConfig(buffer) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf16le', bom: true };
    if (buffer[0] === 0xfe && buffer[1] === 0xff) throw new Error('Unsupported big-endian .wslconfig; convert it explicitly first');
    const bom = buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const data = bom ? buffer.subarray(3) : buffer;
    const text = data.toString('utf8');
    if (!Buffer.from(text).equals(data)) throw new Error('Unsupported .wslconfig encoding');
    return { text, encoding: 'utf8', bom };
}
function encodeConfig(text, format) {
    const payload = Buffer.from(text, format.encoding);
    return format.bom ? Buffer.concat([Buffer.from(format.encoding === 'utf16le' ? [0xff, 0xfe] : [0xef, 0xbb, 0xbf]), payload]) : payload;
}
function inspectConfig(text) {
    let section = '', seenSection = false;
    const values = {};
    for (const line of text.split(/\r?\n/)) {
        const s = line.match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/);
        if (s) { section = s[1].toLowerCase(); if (section === 'wsl2') { if (seenSection) throw new Error('Duplicate [wsl2] sections require manual repair'); seenSection = true; } continue; }
        if (section !== 'wsl2' || /^\s*[#;]/.test(line) || !line.trim()) continue;
        const pair = line.match(/^\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*?)\s*$/);
        if (!pair) throw new Error('Unrecognized [wsl2] configuration line');
        const key = pair[1].toLowerCase();
        if (Object.hasOwn(values, key)) throw new Error('Duplicate [wsl2] key: ' + key);
        values[key] = pair[2].replace(/\s+[#;].*$/, '').trim();
    }
    return values;
}
function mergeWslConfig(text, { swapFile, memoryMiB, processors, swapMiB }) {
    const values = inspectConfig(text);
    if (/^false$/i.test(values.localhostforwarding || '')) throw new Error('WSL localhostForwarding=false: preserve configuration; enable forwarding explicitly before running Freshwater');
    if (!/^[A-Za-z]:\\/.test(swapFile) || /[\r\n"#;]/.test(swapFile)) throw new Error('Invalid Windows swap path');
    for (const [key, val] of Object.entries({ memoryMiB, processors, swapMiB })) if (!Number.isSafeInteger(val) || val < (key === 'swapMiB' ? 0 : 1)) throw new Error('Invalid ' + key);
    const desired = { memory: memoryMiB + 'MB', processors: String(processors), swap: swapMiB + 'MB', swapfile: swapFile.replace(/\\/g, '\\\\') };
    const canonical = { memory: 'memory', processors: 'processors', swap: 'swap', swapfile: 'swapFile' };
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/); let start = -1, end = lines.length;
    for (let i = 0; i < lines.length; i++) {
        const sec = lines[i].match(/^\s*\[([^\]]+)\]/);
        if (sec && sec[1].toLowerCase() === 'wsl2') start = i;
        else if (sec && start >= 0) { end = i; break; }
    }
    if (start < 0) { while (lines.length && lines.at(-1) === '') lines.pop(); if (lines.length) lines.push(''); lines.push('[wsl2]'); start = lines.length - 1; end = lines.length; }
    const remaining = new Set(Object.keys(desired));
    for (let i = start + 1; i < end; i++) {
        const m = lines[i].match(/^(\s*)([A-Za-z][A-Za-z0-9]*)\s*=/);
        const key = m?.[2].toLowerCase();
        if (remaining.has(key)) { lines[i] = m[1] + canonical[key] + '=' + desired[key]; remaining.delete(key); }
    }
    lines.splice(end, 0, ...[...remaining].map(key => canonical[key] + '=' + desired[key]));
    return lines.join(newline).replace(/(?:\r?\n)*$/, newline);
}
function prepareConfig(file, settings) {
    const identity = configIdentity(file);
    const original = identity ? fs.readFileSync(file) : Buffer.alloc(0);
    if (JSON.stringify(configIdentity(file)) !== JSON.stringify(identity)) throw new Error('.wslconfig identity changed while reading preview');
    const format = decodeConfig(original);
    const text = mergeWslConfig(format.text, settings);
    return { file, identity, original, next: encodeConfig(text, format), preview: text,
        originalHash: crypto.createHash('sha256').update(original).digest('hex') };
}
function statIdentity(stat) {
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) throw new Error('.wslconfig must be an ordinary file with no symbolic or hard links');
    return { dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs), changed: String(stat.ctimeNs) };
}
function configIdentity(file) {
    try { return statIdentity(fs.lstatSync(file, { bigint: true })); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function applyConfig(plan, backupDirectory) {
    if (JSON.stringify(configIdentity(plan.file)) !== JSON.stringify(plan.identity)) throw new Error('.wslconfig file identity changed after preview');
    const now = fs.existsSync(plan.file) ? fs.readFileSync(plan.file) : Buffer.alloc(0);
    if (!now.equals(plan.original)) throw new Error('.wslconfig changed after preview; rerun installation');
    if (now.equals(plan.next)) return null;
    fs.mkdirSync(backupDirectory, { recursive: true });
    const backup = path.join(backupDirectory, 'wslconfig-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.bak');
    fs.writeFileSync(backup, now, { flag: 'wx', mode: 0o600 });
    // Open without truncation and validate the descriptor itself. Even if the path
    // changes after our lstat, writes cannot follow a replacement link to a victim.
    const flags = plan.identity ? fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0) : fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL;
    const fd = fs.openSync(plan.file, flags, 0o600);
    try {
        const actual = statIdentity(fs.fstatSync(fd, { bigint: true }));
        if (plan.identity && JSON.stringify(actual) !== JSON.stringify(plan.identity)) throw new Error('.wslconfig descriptor identity changed after preview');
        if (JSON.stringify(configIdentity(plan.file)) !== JSON.stringify(actual)) throw new Error('.wslconfig path identity changed before write');
        const current = fs.readFileSync(fd);
        if (!current.equals(plan.original)) throw new Error('.wslconfig content changed before write');
        fs.ftruncateSync(fd, 0);
        let position = 0;
        while (position < plan.next.length) position += fs.writeSync(fd, plan.next, position, plan.next.length - position, position);
        fs.fsyncSync(fd);
        const after = configIdentity(plan.file);
        if (!after || after.dev !== actual.dev || after.ino !== actual.ino || after.birth !== actual.birth) throw new Error('.wslconfig path identity changed during write; original backup: ' + backup);
    } finally { fs.closeSync(fd); }
    return backup;
}
module.exports = { decodeConfig, encodeConfig, inspectConfig, mergeWslConfig, prepareConfig, applyConfig };
