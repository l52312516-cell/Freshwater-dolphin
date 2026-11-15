'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fault } = require('../errors.cjs');
const { VERSION, LIMIT, METHODS, privateDirectory, readJson, writeJson, remove, claimOwner } = require('./common.cjs');

async function startServer({ dir, backend, maxPending = 32, queueSize = 1000, pollMs = 25,
    eventTtlMs = 60000, now = Date.now, logger = () => {} }) {
    if (!Number.isInteger(eventTtlMs) || eventTtlMs < 1 || eventTtlMs > 60000 || typeof now !== 'function') {
        throw fault('INVALID_CONFIG', 'Event retention must be between 1 and 60000 milliseconds');
    }
    privateDirectory(dir);
    const requests = path.join(dir, 'requests');
    const responses = path.join(dir, 'responses');
    privateDirectory(requests);
    privateDirectory(responses);
    const owner = path.join(dir, 'owner.json');
    const instance = crypto.randomUUID();
    claimOwner(owner, { instance, version: VERSION });
    let sequence = 0, closed = false, polling = false, queueBytes = 0;
    const queue = [], pending = new Set(), controllers = new Set();
    function pruneEvents() {
        const cutoff = now() - eventTtlMs;
        while (queue.length && queue[0].at <= cutoff) queueBytes -= queue.shift().bytes;
    }
    const onEvent = event => {
        try {
            pruneEvents();
            const bytes = JSON.stringify(event, (_key, value) => typeof value === 'bigint' ? value.toString()
                : value instanceof Map ? Object.fromEntries(value) : value);
            sequence++;
            const size = Buffer.byteLength(bytes);
            if (size > LIMIT / 2) { queue.length = 0; queueBytes = 0; logger('event_too_large'); return; }
            queue.push({ seq: sequence, event: JSON.parse(bytes), bytes: size, at: now() });
            queueBytes += size;
            while (queue.length > queueSize || queueBytes > 8 * 1024 * 1024) queueBytes -= queue.shift().bytes;
        } catch (_) { sequence++; queue.length = 0; queueBytes = 0; logger('event_encoding_failed'); }
    };
    backend.on('event', onEvent);

    function events(params) {
        pruneEvents();
        const cursor = params.cursor === undefined ? 0 : params.cursor;
        if (!Number.isSafeInteger(cursor) || cursor < 0 || (params.instance !== undefined && typeof params.instance !== 'string')) {
            throw fault('INVALID_REQUEST', 'Invalid event cursor');
        }
        const changed = params.instance !== undefined && params.instance !== instance;
        const first = queue.length ? queue[0].seq : sequence + 1;
        const start = changed ? first - 1 : cursor;
        const items = [];
        let bytes = 0;
        for (const item of queue) {
            if (item.seq <= start) continue;
            if (items.length >= 100 || bytes + item.bytes > LIMIT * 0.75) break;
            bytes += item.bytes;
            items.push({ seq: item.seq, event: item.event });
        }
        return { instance, cursor: items.length ? items[items.length - 1].seq : sequence,
            gap: changed || start < first - 1 || start > sequence, events: items };
    }

    async function handle(id, file) {
        let request, deadline;
        const controller = new AbortController();
        controllers.add(controller);
        try {
            request = readJson(file);
            if (!request || request.version !== VERSION || request.id !== id || !METHODS.has(request.method) ||
                !request.params || typeof request.params !== 'object' || Array.isArray(request.params) ||
                !Number.isFinite(request.expiresAt) || request.expiresAt > Date.now() + 120000) {
                throw fault('INVALID_REQUEST', 'Invalid RPC envelope');
            }
            if (request.expiresAt <= Date.now()) return;
            const result = await Promise.race([
                Promise.resolve().then(() => request.method === 'events' ? events(request.params)
                    : backend.call(request.method, request.params, { signal: controller.signal, expiresAt: request.expiresAt })),
                new Promise((_, reject) => {
                    deadline = setTimeout(() => { controller.abort(); reject(fault('TIMEOUT', 'RPC deadline elapsed; delivery may be unknown')); },
                        Math.max(1, request.expiresAt - Date.now()));
                    controller.signal.addEventListener('abort', () => reject(fault('NOT_READY', 'RPC server stopped')), { once: true });
                })
            ]);
            if (!closed && !controller.signal.aborted && Date.now() < request.expiresAt) {
                writeJson(path.join(responses, id + '.json'), { version: VERSION, id, ok: true, result });
            }
        } catch (error) {
            if (!closed && !controller.signal.aborted && (!request || !Number.isFinite(request.expiresAt) || request.expiresAt > Date.now())) {
                try { writeJson(path.join(responses, id + '.json'), { version: VERSION, id, ok: false,
                    error: { code: error.code || 'KERNEL_ERROR', message: error.message || 'Kernel operation failed' } }); }
                catch (_) { logger('rpc_response_failed'); }
            }
        } finally { clearTimeout(deadline); controllers.delete(controller); remove(file); }
    }

    async function poll() {
        if (closed || polling) return;
        polling = true;
        try {
            pruneEvents();
            for (const name of fs.readdirSync(requests)) {
                if (/^[a-zA-Z0-9-]{1,100}\.json\.[a-zA-Z0-9-]+\.(?:processing|tmp)$/.test(name)) {
                    const orphan = path.join(requests, name);
                    try { if (Date.now() - fs.lstatSync(orphan).mtimeMs > 120000) remove(orphan); }
                    catch (error) { if (error.code !== 'ENOENT') throw error; }
                    continue;
                }
                if (pending.size >= maxPending) break;
                if (!/^[a-zA-Z0-9-]{1,100}\.json$/.test(name)) continue;
                const source = path.join(requests, name), claimed = source + '.' + instance + '.processing';
                try { fs.renameSync(source, claimed); } catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
                const task = handle(name.slice(0, -5), claimed);
                pending.add(task);
                task.finally(() => pending.delete(task)).catch(() => logger('rpc_cleanup_failed'));
            }
            // Remove only stale response files, never arbitrary directory entries.
            for (const name of fs.readdirSync(responses)) {
                if (!/^[a-zA-Z0-9-]{1,100}\.json$/.test(name)) continue;
                const file = path.join(responses, name);
                try { if (Date.now() - fs.lstatSync(file).mtimeMs > 120000) remove(file); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
        } finally { polling = false; }
    }
    const timer = setInterval(() => poll().catch(() => logger('rpc_poll_failed')), pollMs);
    timer.unref();
    return { instance, async close() {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        backend.removeListener('event', onEvent);
        for (const controller of controllers) controller.abort();
        await Promise.allSettled([...pending]);
        try { if (readJson(owner).instance === instance) remove(owner); } catch (error) { if (error.code !== 'ENOENT') logger('rpc_owner_cleanup_failed'); }
    } };
}

module.exports = { startServer };
