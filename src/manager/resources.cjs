'use strict';

const fs = require('node:fs');
const os = require('node:os');

function memoryAvailable({ platform = process.platform, readFile = fs.readFileSync,
    host = { free: os.freemem(), total: os.totalmem() },
    constrained = () => process.constrainedMemory?.(), available = () => process.availableMemory?.() } = {}) {
    let { free, total } = host;
    if (platform === 'linux') {
        try {
            const match = readFile('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB$/m);
            if (match) free = Number(match[1]) * 1024;
        } catch { /* retain the conservative OS fallback */ }
    }
    // Node 22/libuv accounts for the process's cgroup constraints, including
    // container memory limits. Host MemAvailable alone can admit another QQ
    // when the container has already reached its own limit.
    try { const limit = constrained(); if (Number.isFinite(limit) && limit > 0) total = Math.min(total, limit); } catch {}
    try { const limit = available(); if (Number.isFinite(limit) && limit >= 0) free = Math.min(free, limit); } catch {}
    return { free: Math.max(0, Math.min(free, total)), total };
}

module.exports = { memoryAvailable };
