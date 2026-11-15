'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fault } = require('../errors.cjs');
const { VERSION, METHODS, privateDirectory, readJson, writeJson, remove } = require('./common.cjs');

class RpcClient {
    constructor({ directory, timeoutMs = 10000, maxPending = 32 }) {
        privateDirectory(directory);
        this.directory = directory;
        this.timeoutMs = timeoutMs;
        this.maxPending = maxPending;
        this.pending = 0;
        this.closed = false;
        this.controllers = new Set();
        for (const name of ['requests', 'responses']) privateDirectory(path.join(directory, name));
    }

    async call(method, params = {}, options = {}) {
        if (this.closed) throw fault('NOT_READY', 'RPC client is closed');
        if (!METHODS.has(method)) throw fault('UNSUPPORTED', 'Unknown kernel method');
        if (this.pending >= this.maxPending) throw fault('BUSY', 'Too many pending kernel requests');
        const timeoutMs = options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw fault('INVALID_REQUEST', 'Invalid request timeout');
        if (options.signal && options.signal.aborted) throw fault('ABORTED', 'RPC request cancelled');
        const id = crypto.randomUUID();
        const request = path.join(this.directory, 'requests', id + '.json');
        const response = path.join(this.directory, 'responses', id + '.json');
        const controller = new AbortController();
        const abort = () => controller.abort();
        this.controllers.add(controller);
        this.pending++;
        options.signal?.addEventListener('abort', abort, { once: true });
        const expiresAt = Date.now() + timeoutMs;
        try {
            writeJson(request, { version: VERSION, id, method, params, expiresAt });
            while (Date.now() < expiresAt) {
                if (controller.signal.aborted) throw fault('ABORTED', 'RPC request cancelled; delivery may be unknown');
                try {
                    const value = readJson(response);
                    if (value.version !== VERSION || value.id !== id || typeof value.ok !== 'boolean') throw fault('INVALID_RESPONSE', 'Invalid RPC response');
                    if (!value.ok) throw fault(value.error?.code || 'KERNEL_ERROR', value.error?.message || 'Kernel request failed');
                    return value.result;
                } catch (error) { if (error.code !== 'ENOENT') throw error; }
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw fault('TIMEOUT', 'Kernel request timed out; delivery may be unknown');
        } finally {
            this.pending--;
            this.controllers.delete(controller);
            options.signal?.removeEventListener('abort', abort);
            remove(request);
            remove(response);
        }
    }

    close() { this.closed = true; for (const controller of this.controllers) controller.abort(); }
}

module.exports = { RpcClient };
