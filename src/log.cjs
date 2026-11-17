'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitizeMessageRecord } = require('./message-log.cjs');
const { safeDiagnostic } = require('./diagnostics.cjs');

function createLogger(directory, { maxBytes = 2 * 1024 * 1024, backups = 3 } = {}) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'adapter.jsonl');
    function write(target, record) {
        const line = JSON.stringify(record) + '\n';
        try {
            if (fs.existsSync(target) && fs.statSync(target).size + Buffer.byteLength(line) > maxBytes) {
                for (let index = backups; index >= 1; index--) {
                    const old = index === 1 ? target : target + '.' + (index - 1);
                    const next = target + '.' + index;
                    if (fs.existsSync(next)) fs.unlinkSync(next);
                    if (fs.existsSync(old)) fs.renameSync(old, next);
                }
            }
            fs.appendFileSync(target, line, { mode: 0o600 });
        } catch (_) { process.stderr.write('freshwater: log_write_failed\n'); }
        return line;
    }
    const log = (event, details = {}) => {
        const safe = {};
        // Only explicit operational fields; no token, arbitrary error text or message bodies.
        for (const key of ['code', 'count', 'online', 'ready', 'connected', 'bridge', 'version', 'gap', 'nodeId', 'profileId', 'action', 'stage', 'reason', 'durationMs', 'userId', 'targetId', 'groupId', 'selfId']) {
            const item = details[key];
            if (['boolean', 'number'].includes(typeof item) || item === null ||
                (typeof item === 'string' && /^[\w.:-]{1,100}$/.test(item))) safe[key] = item;
        }
        Object.assign(safe, safeDiagnostic(details));
        if (Number.isInteger(details.messageId) && details.messageId >= -0x80000000 && details.messageId <= 0x7fffffff) safe.messageId = details.messageId;
        const name = typeof event === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(event) ? event : 'diagnostic';
        const record = { id: crypto.randomUUID(), time: new Date().toISOString(), event: name, ...safe };
        process.stdout.write(write(file, record));
    };
    log.message = details => {
        const record = sanitizeMessageRecord({ ...details, id: crypto.randomUUID(), time: new Date().toISOString() });
        // Original chat content is private to the account's bounded message log.
        // It must not appear in container stdout or ordinary diagnostic files.
        if (record) write(path.join(directory, 'messages.jsonl'), record);
    };
    return log;
}

module.exports = { createLogger };
